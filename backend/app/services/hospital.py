"""Fixture-only mock receiving system with retry-safe transactions."""

import sqlite3
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock

from app.schemas.evidence import CaseEvidence, ContractModel
from app.schemas.review import ImportReceipt, ReviewRow, ServiceError


class HospitalError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.detail = ServiceError(code=code, message=message, recoverable=True)


class ApprovedSnapshot(ContractModel):
    evidence: CaseEvidence
    rows: tuple[ReviewRow, ...]


class HospitalRecord(ContractModel):
    snapshot: ApprovedSnapshot
    receipt: ImportReceipt


def _utc_key(timestamp: datetime) -> str:
    if timestamp.utcoffset() is None:
        raise ValueError("An import timestamp must be timezone aware.")
    return timestamp.astimezone(UTC).isoformat(timespec="microseconds")


class MockHospital:
    def __init__(
        self,
        path: str | Path = ":memory:",
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._lock = Lock()
        self._clock = clock
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS imports (
                retry_token TEXT PRIMARY KEY,
                imported_at TEXT NOT NULL,
                snapshot TEXT NOT NULL
            )
            """
        )
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS imports_by_timestamp ON imports (imported_at)"
        )

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def write(
        self, *, evidence: CaseEvidence, rows: Sequence[ReviewRow], retry_token: str
    ) -> ImportReceipt:
        """Write rows after the caller has validated pharmacist approval."""
        if not retry_token.strip() or not rows:
            raise ValueError("An approved import requires rows and a retry token.")
        snapshot = ApprovedSnapshot(evidence=evidence, rows=tuple(sorted(rows, key=lambda row: row.id)))
        payload = snapshot.model_dump_json()
        row_ids = [row.id for row in snapshot.rows]

        with self._lock:
            try:
                with self._db:
                    self._db.execute("BEGIN IMMEDIATE")
                    existing = self._db.execute(
                        "SELECT imported_at, snapshot FROM imports WHERE retry_token = ?",
                        (retry_token,),
                    ).fetchone()
                    if existing is not None:
                        imported_at, previous_payload = existing
                        previous = ApprovedSnapshot.model_validate_json(previous_payload)
                        if previous != snapshot:
                            raise HospitalError(
                                "retry_conflict", "The retry token belongs to a different snapshot."
                            )
                    else:
                        imported_at = _utc_key(self._clock())
                        self._db.execute(
                            "INSERT INTO imports (retry_token, imported_at, snapshot) VALUES (?, ?, ?)",
                            (retry_token, imported_at, payload),
                        )
            except sqlite3.Error:
                raise HospitalError(
                    "hospital_unavailable", "The mock hospital could not save the approved rows."
                ) from None
        return ImportReceipt(imported_at=datetime.fromisoformat(imported_at), imported_row_ids=row_ids)

    def lookup(self, imported_at: datetime) -> list[HospitalRecord]:
        timestamp = _utc_key(imported_at)
        with self._lock:
            try:
                matches = self._db.execute(
                    "SELECT snapshot FROM imports WHERE imported_at = ? ORDER BY retry_token",
                    (timestamp,),
                ).fetchall()
            except sqlite3.Error:
                raise HospitalError(
                    "hospital_unavailable", "The mock hospital could not retrieve the import."
                ) from None
        records = []
        for (payload,) in matches:
            snapshot = ApprovedSnapshot.model_validate_json(payload)
            records.append(
                HospitalRecord(
                    snapshot=snapshot,
                    receipt=ImportReceipt(
                        imported_at=imported_at,
                        imported_row_ids=[row.id for row in snapshot.rows],
                    ),
                )
            )
        return records
