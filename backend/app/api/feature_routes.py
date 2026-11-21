"""Register the Medication Reader feature routers on an application instance."""

import os
from collections.abc import Callable
from secrets import compare_digest
from typing import Annotated

from fastapi import FastAPI, HTTPException, Security
from fastapi.security import APIKeyHeader

from app.ai.client import OpenAIClient
from app.api.admissions import register_admissions
from app.api.checks import create_checks_router
from app.api.encounter_screening import screening_case
from app.api.imports import create_import_router
from app.api.local_products import router as products_router
from app.api.local_screening import create_local_screening_router
from app.api.labels import create_labels_router
from app.api.package_regions import create_package_regions_router
from app.api.medication_analysis import create_medication_analysis_router
from app.api.pill_candidates import router as pill_candidates_router
from app.api.pills import create_pills_router
from app.api.regimens import router as regimens_router
from app.api.review_reports import register_review_reports
from app.schemas.review import ReviewerIdentity
from app.services.hospital import MockHospital
from app.services.import_eligibility import ApprovalLedger

DEMO_REVIEWER_HEADER = APIKeyHeader(
    name="X-Demo-Reviewer-Token", scheme_name="DemoReviewer", auto_error=False
)


def resolve_demo_reviewer(
    token: Annotated[str | None, Security(DEMO_REVIEWER_HEADER)],
) -> ReviewerIdentity:
    credentials = {
        "nurse": os.environ.get("MEDICATION_READER_DEMO_NURSE_TOKEN"),
        "doctor": os.environ.get("MEDICATION_READER_DEMO_DOCTOR_TOKEN"),
        "pharmacist": os.environ.get("MEDICATION_READER_DEMO_REVIEWER_TOKEN"),
    }
    roles = [role for role, expected in credentials.items() if token and expected
             and compare_digest(token.encode(), expected.encode())]
    if len(roles) != 1:
        raise HTTPException(status_code=403, detail="A unique configured demo reviewer token is required.")
    role = roles[0]
    return ReviewerIdentity(id=f"demo-{role}", name=f"Demo {role}", role=role)


def register_feature_routes(
    app: FastAPI,
    *,
    hospital: MockHospital,
    get_provider: Callable[[], OpenAIClient],
    resolve_reviewer: Callable[..., ReviewerIdentity],
) -> None:
    register_admissions(app, hospital, resolve_reviewer)
    app.include_router(create_labels_router(get_provider))
    app.include_router(create_package_regions_router(app.state.admissions, get_provider, resolve_reviewer))
    app.include_router(create_pills_router(get_provider))
    app.include_router(pill_candidates_router)
    app.include_router(create_medication_analysis_router(get_provider))
    authorize_screening = screening_case(app.state.admissions, resolve_reviewer)
    app.include_router(create_checks_router(authorize_screening))
    app.include_router(products_router)
    app.include_router(create_local_screening_router(authorize_screening))
    register_review_reports(app, app.state.admissions, resolve_reviewer)
    app.include_router(regimens_router)
    app.include_router(create_import_router(ApprovalLedger(), hospital, resolve_reviewer, app.state.admissions.can_read))
