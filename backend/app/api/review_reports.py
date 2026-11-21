"""Authenticated FastAPI entry points for transient synthetic screening reports."""

from collections.abc import Callable

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query

from app.schemas.evidence import ContractModel, Text
from app.schemas.review import ReviewerIdentity, ServiceError
from app.schemas.review_scopes import ScreeningKind
from app.services.admissions import AdmissionStore
from app.services.review_snapshots import (
    ReviewSnapshotError,
    ReviewSnapshotStore,
    SnapshotUpdate,
    SnapshotVersion,
    VersionedScreeningReport,
)


class RunReport(ContractModel):
    snapshot_id: Text
    enabled: bool = True


def register_review_reports(
    app: FastAPI, admissions: AdmissionStore, resolve_reviewer: Callable[..., ReviewerIdentity],
) -> None:
    snapshots = ReviewSnapshotStore()
    app.state.review_snapshots = snapshots
    router = APIRouter(prefix="/admissions/{case_id}", tags=["synthetic screening reports"])
    identity = Depends(resolve_reviewer)

    def with_case[T](actor: ReviewerIdentity, case_id: str, action: Callable[[dict], T]) -> T:
        # Serialize report operations with the underlying encounter mutations.
        with admissions.lock:
            case = admissions.get(actor, case_id)
            if actor.role not in {"doctor", "pharmacist"}:
                raise HTTPException(status_code=403, detail="A doctor or pharmacist is required for screening.")
            try:
                return action(case)
            except ReviewSnapshotError as error:
                detail = ServiceError(code=error.code, message=str(error), recoverable=True)
                raise HTTPException(status_code=error.status, detail=detail.model_dump()) from None

    @router.put("/review-snapshot", response_model=SnapshotVersion)
    def update_snapshot(case_id: str, request: SnapshotUpdate, actor: ReviewerIdentity = identity) -> SnapshotVersion:
        return with_case(actor, case_id, lambda case: snapshots.update(case, request))

    @router.get("/review-snapshot", response_model=SnapshotVersion)
    def describe_snapshot(case_id: str, actor: ReviewerIdentity = identity) -> SnapshotVersion:
        return with_case(actor, case_id, snapshots.describe)

    @router.post("/review-reports/{kind}", response_model=VersionedScreeningReport)
    def run_report(
        case_id: str, kind: ScreeningKind, request: RunReport, actor: ReviewerIdentity = identity,
    ) -> VersionedScreeningReport:
        return with_case(
            actor, case_id, lambda case: snapshots.run(case, request.snapshot_id, kind, enabled=request.enabled)
        )

    @router.get("/review-reports/{kind}", response_model=VersionedScreeningReport)
    def read_report(
        case_id: str, kind: ScreeningKind, snapshot_id: str = Query(min_length=1), actor: ReviewerIdentity = identity,
    ) -> VersionedScreeningReport:
        return with_case(actor, case_id, lambda case: snapshots.get_report(case, snapshot_id, kind))

    app.include_router(router)
