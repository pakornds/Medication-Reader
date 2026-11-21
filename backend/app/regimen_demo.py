"""Local synthetic review workspace. Run explicitly with Uvicorn's --factory option."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.admissions import register_admissions
from app.api.encounter_screening import screening_case
from app.api.feature_routes import resolve_demo_reviewer
from app.api.imports import create_import_router
from app.api.local_products import router as products_router
from app.api.local_screening import create_local_screening_router
from app.api.regimens import router as regimen_router
from app.schemas.review import ReviewerIdentity
from app.services.hospital import MockHospital
from app.services.import_eligibility import ApprovalLedger

REPOSITORY = Path(__file__).resolve().parents[2]


def fixture_reviewer() -> ReviewerIdentity:
    return ReviewerIdentity(id="demo-pharmacist", name="Demo pharmacist", role="pharmacist")


def create_app() -> FastAPI:
    hospital = MockHospital()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            yield
        finally:
            hospital.close()

    app = FastAPI(title="Synthetic regimen review demo", lifespan=lifespan)
    app.include_router(regimen_router)
    app.include_router(products_router)
    register_admissions(app, hospital, resolve_demo_reviewer)
    app.include_router(create_local_screening_router(screening_case(app.state.admissions, resolve_demo_reviewer)))
    app.include_router(create_import_router(ApprovalLedger(), hospital, fixture_reviewer))
    app.mount("/regimen-review", StaticFiles(directory=REPOSITORY / "src/components/review"))
    app.mount("/regimen-demo", StaticFiles(directory=REPOSITORY / "demos/regimen", html=True))
    return app
