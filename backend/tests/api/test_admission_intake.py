"""Exercise the actual draft boundary, ordinary clinical actions and hospital receipt."""
from base64 import b64encode
from copy import deepcopy
from io import BytesIO
from uuid import uuid4

from PIL import Image

from test_admissions import client, headers


def observation(value, ref):
    return {"status": "readable", "value": value, "evidence": ref}


def medicine(rid="row-a"):
    order, label, report = (rid + ending for ending in ("-order", "-label", "-report"))
    ref = {"source_id": label}
    directions = "1 tablet each morning"
    schedule = dict(component_id=rid+"-component", basis="documented", parse_status="complete",
                    directions_text=directions, dose_amount=1, dose_unit="tablet", time_of_day=["morning"],
                    schedule_type="frequency", frequency_count=1, period_value=1, period_unit="day")
    schedule["evidence"] = {key: ref for key in schedule if key not in {"component_id", "basis", "parse_status"}}
    return dict(row=dict(id=rid, identity_status="named", observed_names=[
                            {"value":"Synthetic A", "evidence":{"source_id":order}}],
                         sources=[{"source_id":sid} for sid in (order,label,report)], regimens=[schedule],
                         label_fields={"amount_prescribed":observation("21 tablets", {"source_id":order})}),
                origin="manual", catalogue=None,
                sources=[dict(id=sid,kind=kind) for sid,kind in
                         [(order,"other_record"),(label,"other_record"),(report,"patient_report")]],
                items=[], notes={order:"Synthetic transfer list",label:directions,report:"Taking this medicine by mouth"},
                regions={}, physical_items={})


def submission(*rows):
    return {"case_id":str(uuid4()),"rows":list(rows),"originals":{},"revision":0}


def submit(http, payload, expected=200):
    response = http.post("/admissions/intake", json=payload, headers=headers("nurse"))
    assert response.status_code == expected, response.text
    return response.json()


def test_admit_sync_verify_and_import_preserve_quantity_and_schedule(client):
    command = submission(medicine())
    case = submit(client, command)
    assert case["rows"]["row-a"]["verified"] is None and case["revision"] == 1
    assert submit(client, command)["revision"] == 1
    assert len(client.get("/admissions", headers=headers("nurse")).json()) == 1
    changed = deepcopy(command)
    changed["rows"].append(medicine("row-b"))
    submit(client, changed, 409)
    changed["revision"] = 1
    case = submit(client, changed)
    assert case["revision"] == 2 and len(case["rows"]) == 2
    path = "/admissions/" + case["id"] + "/actions"
    for action, role in [
        (dict(action="interview",row_id="row-a",source_id="row-a-report",ownership="patient",
              current_use="current",dose="1 tablet",route="oral",schedule="each morning"),"nurse"),
        (dict(action="verify",row_id="row-a",source_id="row-a-report"),"nurse"),
        (dict(action="import",row_ids=["row-a"]),"pharmacist"),
    ]:
        result = client.post(path, headers=headers(role), json=dict(
            request_id=str(uuid4()),revision=case["revision"],command=action))
        assert result.status_code == 200, result.text
        case = result.json()
    receipt = case["receipts"][0]
    records = client.get("/imports", params={"imported_at":receipt["imported_at"]},headers=headers("pharmacist")).json()
    snapshot = records[0]["snapshot"]["rows"][0]
    assert snapshot["label_fields"]["amount_prescribed"]["value"] == "21 tablets"
    preserved = next(c for c in snapshot["regimens"] if c["component_id"] == "row-a-component")
    assert preserved["dose_amount"] == 1 and preserved["time_of_day"] == ["morning"]
    assert preserved["evidence"]["directions_text"]["source_id"] == "row-a-label"
    changed["revision"] = case["revision"]
    changed["rows"][0]["notes"]["row-a-label"] = "Replaced source"
    submit(client, changed, 409)


def test_shared_scenes_use_one_original_and_show_assigned_region(client):
    def original(color):
        image = BytesIO()
        Image.new("RGB", (20, 20), color).save(image, "PNG")
        return dict(media_type="image/png", data=b64encode(image.getvalue()).decode())
    rows = []
    for index in (0, 1):
        rid = f"row-{index}"
        sources, refs, items, regions = [], [], [], {}
        for side,kind in (("front","label_photo"),("back","reverse_photo")):
            source = f"{side}-{index}"
            sources.append(dict(id=source,kind=kind,attachment_id=side))
            refs.append(dict(source_id=source,item_id=source))
            items.append(dict(id=source,source_id=source,row_id=rid,kind="label_region" if side=="front" else "pill_crop"))
            regions[source] = dict(x=index/2,y=0,width=.5,height=1)
        rows.append(dict(row=dict(id=rid,identity_status="named",sources=refs,
                                  observed_names=[dict(value="Synthetic label",evidence=refs[0])],
                                  reverse_crop=refs[1]),origin="analysis",sources=sources,notes={},items=items,
                         regions=regions,physical_items={s:rid for s in regions}))
    payload = submission(*rows)
    payload["originals"] = {"front":original("red"),"back":original("blue")}
    case = submit(client,payload)
    assert len(case["capture"]["packages"]) == 2 and len(case["intake_attachments"]) == 2
    assert all(m["status"] == "confirmed" for m in case["capture"]["reverse_matches"])
    link = case["capture"]["packages"][1]["items"][0]["evidence"][0]["region"]
    photo = client.post("/admissions/" + case["id"] + "/capture/region", json=link, headers=headers("pharmacist"))
    assert photo.status_code == 200 and Image.open(BytesIO(photo.content)).size == (10, 20)
    payload["originals"] = {}
    assert submit(client, payload)["revision"] == case["revision"]
    payload["revision"] = case["revision"]
    payload["rows"][1]["regions"]["front-1"]["width"] = .4
    case = submit(client, payload)
    stale = client.post("/admissions/" + case["id"] + "/capture/region", json=link, headers=headers("nurse"))
    assert stale.status_code == 404 and case["capture"]["front"]["revision"] == 2


def test_linked_scan_and_draft_corrections_keep_distinct_provenance(client):
    primary = medicine()
    ref = {"source_id": "scan-note"}
    primary.update(linked=[dict(row=dict(id="scan-row", identity_status="named", sources=[ref],
        observed_names=[dict(value="Synthetic A", evidence=ref)], dispensing_source_id="scan-note",
        label_fields={"strength": observation("10 mg", ref)}), origin="analysis",
        sources=[dict(id="scan-note", kind="other_record", organization="Example Clinic",
                      organization_phone="000000", organization_type="clinic")], items=[],
        notes={"scan-note": "Synthetic A 10 mg"}, physical_items={}, regions={})],
        corrections={"strength": "5 mg", "directions": ""})
    command = submission(primary)
    case = submit(client, command)
    row = case["rows"]["row-a"]
    assert len(row["intake_sources"]) == 2 and row["intake_sources"][1]["dispensing_source_id"] == "scan-note"
    entries = {e["source"]["id"]: e for e in row["entries"]}
    assert entries["scan-note"]["strength"] == "10 mg"
    assert entries["scan-note"]["source"]["organization_phone"] == "000000"
    assert entries["intake-correction-row-a-strength"]["strength"] == "5 mg"
    assert entries["intake-correction-row-a-directions"]["source"]["kind"] == "reviewer_record"
    assert row["intake_corrections"]["directions"] == "" and row["verified"] is None
    assert submit(client, command)["revision"] == 1


def test_admission_source_ids_cannot_be_recycled_by_intake(client):
    from test_admissions import record
    command = submission(medicine())
    case = submit(client, command)
    for action in [dict(action="add", entry=record("row-b-label", "other_record", "Original wording")),
                   dict(action="record_unavailable_source", source=dict(id="row-c-label", kind="other_record",
                        availability="unavailable", unavailable_reason="Clinic unreachable"))]:
        response = client.post("/admissions/" + case["id"] + "/actions", headers=headers("nurse"), json=dict(
            revision=case["revision"], request_id=str(uuid4()), command=action))
        assert response.status_code == 200, response.text
        case = response.json()
    for name in ("row-b", "row-c"):
        submit(client, {**command, "revision": case["revision"], "rows": [*command["rows"], medicine(name)]}, 409)
    assert len(client.get("/admissions/" + case["id"], headers=headers("nurse")).json()["rows"]) == 2
