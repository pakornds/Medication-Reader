"""Retake transitions through the assigned admission API using synthetic evidence."""

import base64
import json
from copy import deepcopy
from functools import partial
from pathlib import Path
import pytest

from test_admission_package_capture import picture, submit
from test_admission_screening_attestation import run_drp
from test_admissions import Case, client, headers, photo, record


def label(sid, name, *, owner="Demo A", bag="same package", attachment=None,
          area=(0, .1, .25, .3), orientation=1):
    entry = photo(sid, bag, name=name)
    entry["source"].update(kind="label_photo", attachment_id=attachment)
    entry.update(wording=f"{name} | owner: {owner}", label_owner=owner)
    entry["photo"].update(data=base64.b64encode(picture(orientation)).decode(),
                          region=list(area), front_attributed=True)
    return entry


def verify(case, row, source, ownership_source):
    case.link(row, record(source, "patient_report", "Synthetic report of current use"))
    case.interview(row, source, ownership_source_id=ownership_source, dose="fixture amount",
                   note="Preserve this clinician note.")
    case.send("verify", row_id=row, source_id=source)


def test_targeted_retake_rejects_different_view_and_stale_ownership(client):
    case = Case(client, "nurse")
    row = case.add(label("label-before", "Demo Medicine"))
    verify(case, row, "interview", "label-before")
    prior_answer = case.state["rows"][row]["interview"]
    original = deepcopy(case.state)

    reverse = photo("unrelated-reverse", "same package", "unrelated tablet")
    rejected = case.link(row, reverse, replaces="label-before", status=422)
    assert rejected.json()["detail"] == "Retake the same item and photo view."
    assert case.state == original
    wrong_region = label("wrong-region", "Demo Medicine", area=(.6, .1, .2, .3))
    assert "must overlap" in case.link(row, wrong_region, replaces="label-before", status=422).text

    new_label = label("label-after", "Demo Medicine", owner="Demo B", orientation=8)
    case.link(row, new_label, replaces="label-before")
    last_request = deepcopy(case.payload)
    state = case.state["rows"][row]
    assert state["superseded"] == ["label-before"]
    assert state["interview"] == prior_answer and state["verified"] is None
    failure = case.send("verify", row_id=row, source_id="interview", status=422)
    assert failure.json()["detail"] == "Select an active source linked to this item."
    case.send("interview", row_id=row, source_id="interview", ownership_source_id="label-after",
              ownership="patient", current_use="current", status=422)
    case.interview(row, "interview", ownership="other", current_use="not_owned", note=prior_answer["note"])
    case.send("verify", row_id=row, source_id="interview", identity_source_id="label-after")
    assert case.state["rows"][row]["verified"]["answer"]["note"] == prior_answer["note"]
    assert client.post(case.path + "/actions", json=last_request, headers=headers("nurse")).json() == case.state


def test_shifted_sibling_crop_cannot_replace_same_view_of_target(client):
    case = Case(client, "nurse")
    target = case.add(label("target", "Demo target", orientation=6, area=(.02, .1, .2, .3)))
    case.add(label("other", "Demo other", orientation=8, area=(.6, .1, .25, .3)))
    reused = label("shifted-other", "Demo target", orientation=8, area=(.62, .1, .25, .3))
    prior = deepcopy(case.state)
    response = case.link(target, reused, replaces="target", status=422)
    assert response.json()["detail"] == "The retake crop overlaps a different item."
    assert client.get(case.path, headers=headers("nurse")).json() == prior


def manifest_for(case):
    fixture = Path(__file__).parents[3] / "fixtures/package-capture/two-photos.json"
    return json.loads(fixture.read_text().replace("demo-two-photos", case.state["id"]))


@pytest.mark.parametrize("edit", ["move", "unmatch", "opaque"])
def test_changed_attribution_retires_clinical_use_but_preserves_unchanged_sibling(client, edit):
    case = Case(client, "doctor")
    manifest = manifest_for(case)
    old = "clinic-a" if edit == "move" else "clinic-a-reverse"
    source = label(old, "Demo A", attachment="table-front" if edit == "move" else "table-reverse",
                   area=(.05, .1, .25, .35), orientation=6 if edit == "move" else 1)
    if edit != "move":
        source["source"]["kind"] = "reverse_photo"
        source["photo"].update(pairing="matched", front_attributed=False)
    a = case.add(source)
    c = case.add(label("clinic-c", "Demo C", attachment="table-front", orientation=6, area=(.67, .1, .23, .35)))
    verify(case, a, "report-a", old)
    verify(case, c, "report-c", "clinic-c")
    send = partial(submit, client, case.path, role=case.role)
    initial = send(dict(revision=case.state["revision"], request_id="initial", manifest=manifest,
                        existing_rows={"order-a": a, "order-c": c}), {"front": picture(6), "reverse": picture(1)})
    assert initial.status_code == 200, initial.text
    case.state = initial.json()
    sibling = deepcopy(case.state["rows"][c])
    first = manifest["packages"][0]["items"][0]
    if edit == "move":
        manifest["front"]["revision"] += 1
        manifest["front"]["regions"][0]["bounds"] = deepcopy(manifest["front"]["regions"][3]["bounds"])
        for pkg in manifest["packages"]:
            for ref in pkg["front_regions"] + [v["region"] for item in pkg["items"] for v in item["evidence"]]:
                if ref["side"] == "front":
                    ref["revision"] = manifest["front"]["revision"]
        stale = send(dict(revision=case.state["revision"], request_id="stale", manifest=manifest))
        assert stale.status_code == 422
    elif edit == "opaque":
        manifest["reverse"]["regions"][0]["visibility"] = "opaque"
        manifest["reverse"]["revision"] += 1
        for ref in [m["region"] for m in manifest["reverse_matches"]] + [
            v["region"] for pkg in manifest["packages"] for item in pkg["items"] for v in item["evidence"]
        ]:
            if ref["side"] == "reverse":
                ref["revision"] = manifest["reverse"]["revision"]
    else:
        manifest["reverse_matches"] = [match for match in manifest["reverse_matches"] if match["package_id"] != "package-a"]
    first["evidence"] = [ref for ref in first["evidence"] if ref["source_id"] != old]
    updated = send(dict(revision=case.state["revision"], request_id="withdraw", manifest=manifest))
    assert updated.status_code == 200, updated.text
    case.state = updated.json()
    row = case.state["rows"][a]
    assert old in row["superseded"] and row["verified"] is None
    assert row["entries"][0]["name"] == "Demo A" and row["interview"]["note"] == "Preserve this clinician note."
    assert case.state["rows"][c] == sibling
    assert old in case.state["events"][-1]["superseded_sources"]
    assert not any(source["id"] == old for source in case.state["capture"]["sources"])
    case.send("import", role="pharmacist", row_ids=[a], status=422)


def test_exact_crop_can_only_be_reused_with_explicitly_shared_package(client):
    case = Case(client, "nurse")
    first = case.add(label("first", "Demo first", orientation=3))
    second_source = label("second", "Demo second", area=(.1, .15, .2, .3), orientation=3)
    second = case.add(second_source)
    reuse = label("reuse", "Demo second", orientation=3)
    rejected = case.link(second, reuse, replaces="second", status=422)
    assert "same confirmed package" in rejected.text

    manifest = manifest_for(case)
    shared = manifest["packages"][1]
    saved = submit(client, case.path, dict(
        revision=case.state["revision"], request_id="same-package", manifest=manifest,
        existing_rows={item["row_id"]: row for item, row in zip(shared["items"], (first, second), strict=True)},
    ), {"front": picture(6), "reverse": picture(1)})
    assert saved.status_code == 200, saved.text
    case.state = saved.json()
    case.link(second, reuse, replaces="second")
    assert case.state["rows"][first]["superseded"] == []
    assert case.state["rows"][second]["superseded"] == ["second"]


def test_item_then_whole_view_retake_and_pharmacist_handoff(client):
    case = Case(client, "doctor")
    capture = partial(submit, client, case.path, role=case.role)
    old_front = "table-front"
    row_a = case.add(label("table-label-a", "Demo Slate", attachment=old_front, orientation=6))
    row_c = case.add(label("table-label-c", "Demo Amber", attachment=old_front, orientation=6,
                           area=(.67, .1, .23, .35)))
    verify(case, row_a, "report-a", "table-label-a")
    verify(case, row_c, "report-c", "table-label-c")
    manifest = manifest_for(case)
    initial = dict(revision=case.state["revision"], request_id="first-view", manifest=manifest,
                   existing_rows={"order-a": row_a, "order-c": row_c})
    originals = {"front": picture(6), "reverse": picture(1)}
    initial_capture = capture(initial, originals)
    assert initial_capture.status_code == 200, initial_capture.text
    case.state = initial_capture.json()
    alias = label("alias-c", "Demo Amber", attachment="unused-attachment-id", orientation=6,
                  area=(.67, .1, .23, .35))
    case.link(row_c, alias)
    mislabeled = deepcopy(alias)
    mislabeled["source"].update(id="cross-view-alias", kind="reverse_photo")
    mislabeled["photo"]["front_attributed"] = False
    case.link(row_c, mislabeled)
    case.interview(row_c, "report-c", ownership_source_id="cross-view-alias",
                   note="Preserve this clinician note.")
    case.send("verify", row_id=row_c, source_id="report-c", identity_source_id="cross-view-alias")
    previous_c = deepcopy(case.state["rows"][row_c])
    previous_reverse = deepcopy(case.state["capture"]["reverse"])
    case.link(row_a, label("target-a", "Demo Slate", orientation=3), replaces="table-label-a")
    assert case.state["rows"][row_c] == previous_c
    assert not case.state["rows"][row_a]["verified"]
    assert case.state["capture"]["front"]["attachment_id"] == old_front
    case.interview(row_a, "report-a", ownership_source_id="target-a", note="Kept item edit.")
    case.send("verify", row_id=row_a, source_id="report-a")
    wrong_item = label("crop-of-capture-only-sibling", "Demo Slate", attachment=old_front,
                       orientation=6, area=(.41, .13, .06, .09))
    assert "overlaps a different item" in case.link(row_a, wrong_item, replaces="target-a", status=422).text
    for pending in sorted(set(case.state["rows"]) - {row_a, row_c}):
        case.link(pending, record(f"note-{pending}", "reviewer_record", "Appearance remains unidentified"))
    case.interview(row_c, "report-c", ownership_source_id="cross-view-alias", dose=None,
                   note="Preserve this clinician note.")
    case.send("attest_current_use", row_id=row_c, source_id="report-c")
    screened_c = case.state["rows"][row_c]
    assert screened_c["verified"] is None
    assert screened_c["screening_attestation"]["identity"]["source_id"] == "cross-view-alias"
    snapshot, before_report = run_drp(case)
    assert before_report["coverage"]["evaluated_scopes"] == 1

    replacement = deepcopy(manifest)
    replacement["front"].update(attachment_id="front-retaken", revision=2, exif_orientation=8)
    for source in replacement["sources"]:
        if source["attachment_id"] == old_front:
            source.update(id="new-" + source["id"], attachment_id="front-retaken")
    replacement["sources"] = [s for s in replacement["sources"] if s["id"] != "clinic-a-reverse"]
    for package in replacement["packages"]:
        for ref in package["front_regions"]:
            ref.update(attachment_id="front-retaken", revision=2)
        for item in package["items"]:
            item["evidence"] = [entry for entry in item["evidence"] if entry["region"]["side"] == "front"]
            for entry in item["evidence"]:
                entry["region"].update(attachment_id="front-retaken", revision=2)
                entry["source_id"] = "new-" + entry["source_id"]
    command = dict(revision=case.state["revision"], request_id="whole-retake", manifest=replacement)
    upload = {"front": picture(8)}
    assert capture(command, upload).status_code == 409
    command["replaces_view"] = dict(side="front", attachment_id=old_front, revision=1)
    assert capture(command, upload).status_code == 422
    replacement["reverse_matches"] = [m for m in replacement["reverse_matches"] if m["status"] == "candidate"]
    stale_candidate = capture(command, upload)
    assert stale_candidate.status_code == 422 and "reverse matches again" in stale_candidate.text
    replacement["reverse_matches"] = []
    repeated_original = deepcopy(command)
    repeated_original["manifest"]["front"]["exif_orientation"] = 6
    repeated = capture(repeated_original, {"front": picture(6)})
    assert repeated.status_code == 422 and "different original" in repeated.text
    rejected = deepcopy(command)
    rejected["manifest"]["sources"][0]["id"] = "clinic-a"
    rejected["manifest"]["packages"][0]["items"][0]["evidence"][0]["source_id"] = "clinic-a"
    assert capture(rejected, upload).status_code == 422

    saved = capture(command, upload)
    assert saved.status_code == 200, saved.text
    case.state = saved.json()
    assert case.state["rows"][row_a]["verified"]["answer"]["note"] == "Kept item edit."
    new_c = case.state["rows"][row_c]
    assert new_c["superseded"] == ["table-label-c", "alias-c", "cross-view-alias"]
    assert new_c["verified"] is None
    assert "screening_attestation" not in new_c
    assert new_c["interview"] == screened_c["interview"]
    _, after_report = run_drp(case, snapshot)
    assert after_report["coverage"]["evaluated_scopes"] == 0
    assert case.state["capture"]["reverse"] == previous_reverse
    assert not case.state["capture"]["reverse_matches"]
    old_links = [p["front_regions"][0] for p in manifest["packages"]]
    for ref in old_links:
        stale = client.post(case.path + "/capture/region", headers=headers("pharmacist"), json=ref)
        assert stale.status_code == 404
    assert capture(initial, originals).json() == case.state
    assert capture(command, upload).json() == case.state
    case.send("verify", row_id=row_c, source_id="report-c", status=422)
    stale = case.send("attest_current_use", row_id=row_c, source_id="report-c", status=422)
    assert stale.json()["detail"] == "Select an active source linked to this item."
    for attachment in (old_front, None, "new-attachment-id", "front-retaken"):
        reused = label("new-logical-old-image", "Demo Amber", attachment=attachment,
                       orientation=6, area=(.67, .1, .23, .35))
        assert "current capture original" in case.link(row_c, reused, status=422).text
    current_label = label("current-clinic-c", "Demo Amber", attachment="front-retaken", orientation=8,
                          area=(.67, .1, .23, .35))
    case.link(row_c, current_label)
    for attachment in ("front-retaken", None, "fresh-reverse-alias"):
        wrong_image = label("cross-view", "Demo Amber", attachment=attachment, orientation=1,
                            area=(.67, .1, .23, .35))
        assert "match its original" in case.link(row_c, wrong_image, replaces="current-clinic-c", status=422).text

    pending = next(row for row in case.state["rows"] if row not in {row_a, row_c})
    case.send("refer", row_ids=[pending], checked="Reviewed active evidence", reason="Identify appearance")
    resumed = client.get(case.path, headers=headers("pharmacist")).json()
    assert resumed["status"] == "Awaiting pharmacist review"
    assert resumed["rows"][row_a]["verified"] and not resumed["rows"][row_c]["verified"]
    assert resumed["rows"][row_c]["interview"]["note"] == "Preserve this clinician note."
