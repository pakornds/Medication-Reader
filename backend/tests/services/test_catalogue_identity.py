import json
import sqlite3

import pytest

from app.ai.client import ProviderError
from app.services.catalogue_identity import resolve_scan_identities
from app.services.medication_analysis import AnalysisPreview, FormAnalysisInput


@pytest.fixture
def catalogue(tmp_path, monkeypatch):
    path = tmp_path / "catalogue.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE product(tpu TEXT PRIMARY KEY,label TEXT,active_tmt INTEGER,
                                 source_generic TEXT,source_strength TEXT,form TEXT);
            CREATE TABLE metadata(key TEXT,value TEXT);
            INSERT INTO metadata VALUES('tmt_release','fixture-snapshot');
        """)
        for code, trade, ingredient, strength, form, active in (
            ("1", "SIADOCIN", "doxycycline", "100 mg", "capsule, hard", 1),
            ("2", "SIADOCIN", "doxycycline", "100 mg", "film-coated tablet", 1),
            ("3", "DOXYCYCLINE (PLEURODESIS)", "doxycycline hyclate", "500 mg", "solution", 1),
            ("4", "SIADOCIN PLUS", "doxycycline + another substance", "100 mg + 10 mg", "tablet", 1),
            ("5", "Retired", "sample", "10 mg", "tablet", 0),
            ("6", "Ambiguous", "sample", "10 mg", "tablet", 1),
            ("7", "Ambiguous", "another substance", "10 mg", "tablet", 1),
        ):
            display = " + ".join(f"{name} {s}" for name, s in zip(ingredient.split(" + "), strength.split(" + ")))
            label = f"{trade} (Synthetic manufacturer) ({display}) {form}, 1 unit"
            db.execute("INSERT INTO product VALUES (?,?,?,?,?,?)",
                       (code, label, active, ingredient, strength, form))
    monkeypatch.setenv("LOCAL_TMT_DB", str(path))


class Reviewer:
    def __init__(self, choice=None):
        self.choice = choice
        self.calls = []

    def generate(self, *, evidence_text, output_type, **kwargs):
        assert output_type.__name__ == "CatalogueDecision"
        body = json.loads(evidence_text)
        self.calls.append(body)
        if self.choice == "timeout":
            raise ProviderError("provider_timeout", "Timed out")
        if self.choice is not None:
            return output_type(candidate_tpus=self.choice)
        return output_type(candidate_tpus=[r["tpu"] for r in body["tmt_records"]])


def preview_for(names, *, strength=None, form=None, side="label_photo"):
    ref = {"source_id": "scan", "item_id": "box"}
    evidence = dict(case_id="case", sources=[dict(id="scan", kind=side)],
                    items=[dict(id="box", source_id="scan", row_id="row", kind="label_region")])
    row = dict(id="row", identity_status="named", observed_names=[dict(value=s, evidence=ref) for s in names],
               sources=[ref], label_fields={k: dict(value=v, status="readable", evidence=ref)
                                             for k, v in (("strength",strength),("form",form)) if v})
    return AnalysisPreview(case_id="case",rows=[row]), FormAnalysisInput(evidence=evidence)


def test_model_adjudicates_scanned_brand_generic_and_variant_against_actual_candidate_fields(catalogue):
    names = ["Siadocin", "Doxycyclin", "Doxycycline"]
    preview, form = preview_for(names, strength="100mg", form="Capsule")
    model = Reviewer()
    result = resolve_scan_identities(preview, form, lambda: model)["row"]
    assert result.model_dump() == {"ingredient":"doxycycline", "trade_name":"SIADOCIN",
        "release":"fixture-snapshot", "candidate_tpus":["1"], "compatible_tpus":["1"], "evidence":[{"source_id":"scan","item_id":"box"}]}
    assert model.calls[0]["printed_names"] == names
    assert [f.value for f in preview.rows[0].observed_names] == names


@pytest.mark.parametrize(("names","strength","form","expect"), [
    (["SIADOCIN"], None, None, ("doxycycline","SIADOCIN",["1","2"])),
    (["SIADOCIN", "DOXYCYCLINE"], "100 mg", "hard capsule", ("doxycycline","SIADOCIN",["1"])),
    (["SIADOCIN", "DOXYCYCLINE"], "100 mg", "soft capsule", None),
    (["doxycycline"], None, None, ("doxycycline",None,["1","2"])),
    (["SIADOCIN PLUS"],None,None,("doxycycline + another substance","SIADOCIN PLUS",["4"])),
    (["DOXYCYCLINE (PLEURODESIS)"],None,None,("doxycycline hyclate","DOXYCYCLINE (PLEURODESIS)",["3"])),
    (["Siadocin","Sertraline"],None,None,None),
    (["Siadocin","Doxycyclin"],"50 mg","Capsule",None),
    (["Siadocin"],None,"eye drops",None),
    (["SIADOCIN PLUS","doxycycline"],None,None,None),
    (["Doxycyclin"],None,None,None),
    (["Retired"],None,None,None),
    (["Ambiguous"],None,None,None),
])
def test_resolve_only_agreeing_compositions_without_assuming_a_presentation(catalogue,names,strength,form,expect):
    preview, request = preview_for(names, strength=strength, form=form)
    model = Reviewer()
    result = resolve_scan_identities(preview, request, lambda: model)
    if expect:
        identity = result["row"]
        assert (identity.ingredient, identity.trade_name, sorted(identity.candidate_tpus)) == expect
    else:
        assert result == {} and not model.calls


@pytest.mark.parametrize("choice", [["1","outside"], [], "timeout"])
def test_model_disagreement_or_unavailability_leaves_only_source_names(catalogue,choice):
    preview, request = preview_for(["Siadocin"])
    assert resolve_scan_identities(preview,request,lambda:Reviewer(choice)) == {}
    assert preview.rows[0].observed_names[0].value == "Siadocin"


def test_reverse_and_missing_catalogue_leave_identity_unresolved(catalogue,monkeypatch,tmp_path):
    model = Reviewer()
    preview, request = preview_for(["Siadocin"], side="reverse_photo")
    assert resolve_scan_identities(preview,request,lambda:model) == {}
    monkeypatch.setenv("LOCAL_TMT_DB", str(tmp_path / "missing"))
    preview, request = preview_for(["Siadocin"])
    assert resolve_scan_identities(preview,request,lambda:model) == {} and not model.calls


def test_intake_rechecks_candidate_source_ids_release_and_display_names(catalogue):
    from app.services.catalogue_identity import supported_intake_identity
    from app.schemas.evidence import EvidenceRef

    preview, request = preview_for(["Siadocin","Doxycycline"], form="Capsule")
    identity = resolve_scan_identities(preview,request,lambda:Reviewer())["row"]
    inputs = (preview.rows[0], request.evidence.items, request.evidence.sources)
    assert supported_intake_identity(identity,*inputs) == identity
    for patch in [
        {"ingredient": "unrelated"}, {"release": "old"}, {"trade_name": "other"},
        {"candidate_tpus":["2"]}, {"candidate_tpus":["1","1"]},
        {"evidence":[EvidenceRef(source_id="another item")]},
    ]:
        assert supported_intake_identity(identity.model_copy(update=patch),*inputs) is None
    assert supported_intake_identity(identity,inputs[0],[],inputs[2]) is None


@pytest.mark.parametrize("marked", [True, False], ids=["marked-label", "whole-scene"])
def test_analysis_endpoint_adjudicates_each_grounded_label_once(catalogue, marked):
    from io import BytesIO

    from fastapi.testclient import TestClient
    from PIL import Image

    from app.main import create_app

    class ScanReviewer(Reviewer):
        def generate(self, *, evidence_text, output_type, **kwargs):
            match output_type.__name__:
                case "ProposedBounds":
                    return output_type(regions=[dict(x=0, y=0, width=1, height=1)])
                case "PrintedLabel":
                    return output_type(names=["Siadocin", "Doxycycline"], strength="100 mg", form="hard capsule")
                case "LabelAnalysisResult":
                    raise ProviderError("provider_invalid_output", "Use the per-crop transcript")
                case "CatalogueDecision":
                    return super().generate(evidence_text=evidence_text, output_type=output_type)
                case _:
                    pytest.fail(f"Unexpected provider roundtrip: {output_type.__name__}")

    photo = BytesIO()
    Image.new("RGB", (30, 30)).save(photo, format="PNG")
    request = dict(evidence=dict(case_id="case", sources=[
        dict(id="front", kind="label_photo", attachment_id="front")
    ]), photo_source_ids=["front"], scene_photo_ids=[] if marked else ["front"])
    if marked:
        request["evidence"]["sources"].append(dict(id="mark", kind="label_photo", attachment_id="front"))
        request["evidence"]["items"] = [dict(id="box", row_id="row", source_id="mark", kind="label_region")]
        request["region_locations"] = {"mark": {"box":"0%,0%,100%,100%"}}
    model = ScanReviewer()
    with TestClient(create_app(get_provider=lambda:model)) as client:
        response = client.post("/medication-analysis", files=[
            ("form", (None, json.dumps(request), "application/json")),
            ("photos", ("synthetic.png", photo.getvalue(), "image/png")),
        ])
    assert response.is_success, response.text
    data = response.json()
    row, = data["rows"]
    assert len(model.calls) == 1
    identity = data["catalogue_identities"][row["id"]]
    assert (identity["ingredient"], identity["trade_name"], identity["candidate_tpus"]) == ("doxycycline","SIADOCIN",["1"])
    assert identity["evidence"] == row["sources"]


def test_pasted_text_matches_catalogue_without_photos(catalogue):
    from app.services.medication_analysis import analyze_medication_form

    source = {"source_id": "written-list"}
    wording = "SIADOCIN 100 mg: 1 capsule each morning"
    form = FormAnalysisInput.model_validate({
        "evidence": {"case_id": "case", "sources": [{"id": "written-list", "kind": "other_record"}]},
        "other_source_notes": [{"value": wording, "evidence": source}],
    })

    class TextReviewer(Reviewer):
        def generate(self, *, output_type, **kwargs):
            if output_type.__name__ == "FormProposal":
                return output_type.model_validate({
                    "case_id": "case",
                    "rows": [{
                        "id": "row", "identity_status": "named", "sources": [source],
                        "observed_names": [{"value": "SIADOCIN", "evidence": source}],
                        "label_fields": {
                            "strength": {"status": "readable", "value": "100 mg", "evidence": source},
                            "directions": {"status": "readable", "value": "1 capsule each morning", "evidence": source},
                        },
                    }],
                })
            return super().generate(output_type=output_type, **kwargs)

    provider = TextReviewer()
    preview = analyze_medication_form(form, [], lambda: provider)
    identity = preview.catalogue_identities["row"]
    assert identity.trade_name == "SIADOCIN" and identity.ingredient == "doxycycline"
    assert identity.compatible_tpus == ["1", "2"]
    assert identity.evidence[0].source_id == "written-list"
    assert preview.rows[0].regimens[0].time_of_day == ["morning"]
    assert len(provider.calls) == 1
