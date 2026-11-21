"""Clinical confirmation carries one installed TMT reference through admission and import."""
import gzip
import shutil
from datetime import datetime
from pathlib import Path

import pytest

from test_admissions import Case, client, headers, photo, record


@pytest.fixture(scope="module")
def catalogue(tmp_path_factory):
    archive = Path(__file__).resolve().parents[3] / "reference-data/tmt-20200217/tmt-fest-mapping.sqlite.gz"
    path = tmp_path_factory.mktemp("admission-catalogue") / "tmt.sqlite"
    with gzip.open(archive, "rb") as source, path.open("wb") as target:
        shutil.copyfileobj(source, target)
    return path


def add_reported_row(case, identity, sid):
    row = case.add(record(sid, "prescription", identity, name=identity))
    case.link(row, record(sid + "-use", "patient_report", "Synthetic patient interview"))
    case.interview(row, sid + "-use", dose="documented interview amount")
    return row


def test_confirmed_candidate_and_no_match_across_sessions(client, catalogue, monkeypatch):
    monkeypatch.setenv("LOCAL_TMT_DB", str(catalogue))
    choices = client.get("/checks/local/products", params={"q": "AMLOC"}).json()
    release = choices["tmt_release"]
    options = {p["tpu"]: p for p in choices["products"]}
    assert options["108455"]["strength"] == "5 mg" and options["108591"]["strength"] == "10 mg"
    case = Case(client, "doctor")
    confirmed = add_reported_row(case, options["108455"]["label"], "clinic")
    ambiguous = add_reported_row(case, "AMLOC", "list")
    unmatched = add_reported_row(case, "Uncatalogued synthetic medicine", "ward")

    event = {"tpu": "108455", "tmt_release": release}
    case.send("verify", row_id=confirmed, source_id="clinic-use", confirmed_product={
        "tpu": "108591", "tmt_release": release,
    }, status=422)
    case.send("verify", row_id=confirmed, source_id="clinic-use", confirmed_product=event)
    case.send("verify", row_id=ambiguous, source_id="list-use")
    case.send("verify", row_id=unmatched, source_id="ward-use")
    second = client.get(case.path, headers=headers("pharmacist")).json()
    verification = second["rows"][confirmed]["verified"]
    assert verification["actor"]["role"] == "doctor"
    assert verification["identity"] == {
        "name": options["108455"]["label"], "source_id": "clinic",
        "normalized_medication_id": "108455", "tmt_release": release,
    }
    for row in (ambiguous, unmatched):
        assert second["rows"][row]["verified"]["identity"].get("normalized_medication_id") is None
    case.send("import", role="pharmacist", row_ids=[confirmed, ambiguous, unmatched])
    receipt, = case.state["receipts"]
    stored, = client.get("/imports", params={"imported_at": receipt["imported_at"]}, headers=headers("pharmacist")).json()
    verified = {r["id"]: r["verification"] for r in stored["snapshot"]["rows"]}
    assert (verified[confirmed]["normalized_medication_id"], verified[confirmed]["tmt_release"]) == ("108455", release)
    assert verified[confirmed]["identity"]["evidence"] == {"source_id": "clinic", "item_id": confirmed}
    assert verified[confirmed]["dose"]["value"] == "documented interview amount"
    assert verified[confirmed]["dose"]["evidence"]["source_id"] == "clinic-use"
    assert datetime.fromisoformat(verified[confirmed]["verified_at"]) == datetime.fromisoformat(verification["at"])
    assert verified[confirmed]["reviewer"] == verification["actor"]
    for row in (ambiguous, unmatched):
        assert verified[row]["normalized_medication_id"] is None and verified[row]["tmt_release"] is None


def test_confirmation_requires_resolved_identity_and_valid_catalogue_pair(client, catalogue, monkeypatch):
    monkeypatch.setenv("LOCAL_TMT_DB", str(catalogue))
    case = Case(client, "nurse")
    row = add_reported_row(case, "Evidenced synthetic medication", "clinic")
    for candidate in ({"tpu": "108455"}, {"tpu": 108455, "tmt_release": "TMTRF20200217"},
                      {"tpu": "108455", "tmt_release": "wrong"}, {"tpu": "missing", "tmt_release": "TMTRF20200217"}):
        case.send("verify", row_id=row, source_id="clinic-use", confirmed_product=candidate, status=422)
        assert client.get(case.path, headers=headers("pharmacist")).json() == case.state
    loose = case.add(photo("loose", "bag", appearance="oval"))
    case.link(loose, record("report", "patient_report", "Synthetic account"))
    case.interview(loose, "report")
    case.send("propose", row_id=loose, name="AMLOC", reference="108591")
    case.send("verify", row_id=loose, source_id="report", confirmed_product={
        "tpu": "108591", "tmt_release": "TMTRF20200217",
    }, status=422)
    assert case.state["rows"][loose]["verified"] is None
