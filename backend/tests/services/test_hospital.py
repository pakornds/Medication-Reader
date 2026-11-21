import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.schemas.analysis import AnalysisRequest
from app.schemas.review import ReviewRow
from app.services.hospital import HospitalError, MockHospital

FIXTURE = Path(__file__).parents[1] / "fixtures" / "contracts" / "transfer_case.json"
STAMP = datetime(2026, 11, 21, 4, 0, tzinfo=UTC)


@pytest.fixture
def approved():
    case = json.loads(FIXTURE.read_text(encoding="utf-8"))
    evidence = AnalysisRequest.model_validate(case["request"]).evidence
    row = case["response"]["rows"][1]
    identity = row["observed_names"][0]
    reviewer = {"id": "demo-pharmacist", "name": "Demo pharmacist", "role": "pharmacist"}
    approved_row = ReviewRow.model_validate(
        {
            **row,
            "revision": 1,
            "verification": {
                "reviewer": reviewer,
                "verified_at": STAMP,
                "status": "no_longer_current",
                "identity": identity,
                "evidence": [identity["evidence"]],
            },
            "approval": {
                "pharmacist_id": reviewer["id"], "approved_at": STAMP, "row_revision": 1
            },
        }
    )
    return {"evidence": evidence, "rows": [approved_row]}


@pytest.fixture
def hospital(tmp_path):
    store = MockHospital(tmp_path / "demo.sqlite", clock=lambda: STAMP)
    yield store
    store.close()


def test_concurrent_retries_write_once_across_connections(hospital, tmp_path, approved):
    other_connection = MockHospital(tmp_path / "demo.sqlite", clock=lambda: STAMP)
    try:
        stores = [hospital, other_connection] * 5
        with ThreadPoolExecutor(max_workers=5) as workers:
            receipts = list(
                workers.map(lambda store: store.write(**approved, retry_token="retry"), stores)
            )
        assert all(receipt == receipts[0] for receipt in receipts)
        assert receipts[0].imported_at == STAMP
        assert len(hospital.lookup(STAMP)) == 1
    finally:
        other_connection.close()


def test_reused_token_with_changed_snapshot_conflicts(hospital, approved):
    hospital.write(**approved, retry_token="retry")
    approved["rows"][0].revision = 2
    with pytest.raises(HospitalError) as exc:
        hospital.write(**approved, retry_token="retry")
    assert exc.value.detail.code == "retry_conflict"
    assert hospital.lookup(STAMP)[0].snapshot.rows[0].revision == 1


def test_lookup_returns_all_imports_with_same_timestamp(hospital, approved):
    hospital.write(**approved, retry_token="alpha")
    hospital.write(**approved, retry_token="bravo")
    matches = hospital.lookup(STAMP)
    assert len(matches) == 2
    assert all(match.receipt.imported_at == STAMP for match in matches)
    assert all(match.receipt.imported_row_ids == ["row-b"] for match in matches)


def test_failed_write_leaves_no_record_or_retry_token(hospital, tmp_path, approved):
    connection = sqlite3.connect(tmp_path / "demo.sqlite")
    try:
        connection.execute(
            """
            CREATE TRIGGER fail_import BEFORE INSERT ON imports
            BEGIN SELECT RAISE(ABORT, 'demo failure'); END
            """
        )
        with pytest.raises(HospitalError) as exc:
            hospital.write(**approved, retry_token="retry")
        assert exc.value.detail.recoverable is True
        assert hospital.lookup(STAMP) == []

        connection.execute("DROP TRIGGER fail_import")
        receipt = hospital.write(**approved, retry_token="retry")
        assert receipt.imported_at == STAMP
        assert len(hospital.lookup(STAMP)) == 1
    finally:
        connection.close()
