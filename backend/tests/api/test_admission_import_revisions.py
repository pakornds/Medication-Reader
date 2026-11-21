"""Admission imports are unique to a verified row snapshot in the encounter."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from test_admissions import Case, client, headers, record


def add_verified_row(case, label):
    row = case.add(record(f"order-{label}", "prescription", f"Demo {label}", name=f"Demo {label}"))
    source = f"report-{label}"
    case.link(row, record(source, "patient_report", f"Reports taking Demo {label}"))
    case.interview(row, source)
    case.send("verify", row_id=row, source_id=source)
    return row


def readback(case, receipt):
    response = case.http.get("/imports", headers=headers("pharmacist"),
                             params={"imported_at": receipt["imported_at"]})
    assert response.status_code == 200
    stored, = response.json()
    return stored["snapshot"]["rows"]


def test_exact_retry_mixed_selection_and_changed_review(client):
    case = Case(client, "nurse")
    a = add_verified_row(case, "A")
    b = add_verified_row(case, "B")
    case.send("import", role="pharmacist", row_ids=[a])
    receipt, = case.state["receipts"]
    original_request = case.payload
    assert case.state["rows"][a]["imported_at"] == receipt["imported_at"]
    assert case.state["rows"][b].get("imported_at") is None

    case.send("verify", row_id=b, source_id="report-B")
    case.send("verify", row_id=a, source_id="report-A", role="pharmacist")
    replay = client.post(case.path + "/actions", json=original_request, headers=headers("pharmacist"))
    assert replay.status_code == 200
    assert replay.json()["receipts"] == [receipt]

    for selection in ([a], [a, b]):
        duplicate = case.send("import", role="pharmacist", row_ids=selection, status=409)
        assert duplicate.json()["detail"] == f"Already imported: {a}. Select only eligible rows."
        assert client.get(case.path, headers=headers("pharmacist")).json() == case.state
    assert [row["id"] for row in readback(case, receipt)] == [a]

    case.send("import", role="pharmacist", row_ids=[b])
    assert [row["id"] for row in readback(case, case.state["receipts"][-1])] == [b]
    case.interview(a, "report-A", dose="2 fixture tablets")
    assert case.state["rows"][a].get("imported_at") is None
    case.send("import", role="pharmacist", row_ids=[a], status=422)
    case.send("verify", row_id=a, source_id="report-A")
    case.send("import", role="pharmacist", row_ids=[a])
    changed, = readback(case, case.state["receipts"][-1])
    assert changed["id"] == a
    assert changed["verification"]["dose"]["value"] == "2 fixture tablets"


def test_concurrent_requests_and_exact_retry_write_once(client):
    case = Case(client, "nurse")
    row = add_verified_row(case, "A")
    command = {"action": "import", "row_ids": [row]}
    requests = [
        {"revision": case.state["revision"], "request_id": str(uuid4()), "command": command}
        for _ in range(2)
    ]

    def submit(request):
        return client.post(case.path + "/actions", json=request, headers=headers("pharmacist"))

    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(submit, [requests[0], requests[0], requests[1]]))
    assert results[0].status_code == results[1].status_code
    assert {results[0].status_code, results[2].status_code} == {200, 409}
    current = client.get(case.path, headers=headers("pharmacist")).json()
    receipt, = current["receipts"]
    retry_payload = requests[0] if results[0].status_code == 200 else requests[1]
    assert submit(retry_payload).json()["receipts"] == [receipt]
    assert [saved["id"] for saved in readback(case, receipt)] == [row]
