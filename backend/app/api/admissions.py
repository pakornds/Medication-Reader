from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.staticfiles import StaticFiles

from app.schemas.admission import Action, NewEncounter
from app.schemas.review import ReviewerIdentity
from app.services.admissions import AdmissionStore
from app.services.catalog import catalogue_choices


def register_admissions(app, hospital, resolve_reviewer):
    store = AdmissionStore(hospital)
    app.state.admissions = store
    router = APIRouter(prefix="/admissions", tags=["admission review"])
    reviewer = Depends(resolve_reviewer)

    @router.get("/session")
    def session(actor: ReviewerIdentity = reviewer):
        return {"actor": actor, "catalogue": catalogue_choices()}

    @router.get("")
    def assigned(actor: ReviewerIdentity = reviewer):
        return store.list(actor)

    @router.post("", status_code=201)
    def create(request: NewEncounter, actor: ReviewerIdentity = reviewer):
        return store.create(actor, request)

    @router.get("/{case_id}")
    def read(case_id: str, actor: ReviewerIdentity = reviewer):
        return store.get(actor, case_id)

    @router.get("/{case_id}/candidates")
    def candidates(case_id: str, actor: ReviewerIdentity = reviewer):
        return store.candidates(actor, case_id)

    @router.post("/{case_id}/actions")
    def apply(case_id: str, request: Action, actor: ReviewerIdentity = reviewer):
        return store.apply(actor, case_id, request)

    @app.middleware("http")
    async def protect_review_records(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(("/admissions", "/imports")):
            response.headers["Cache-Control"] = "no-store"
        return response

    app.include_router(router)
    directory = Path(__file__).resolve().parents[3] / "src" / "admission"
    if directory.is_dir():
        app.mount("/admission", StaticFiles(directory=directory, html=True), name="admission")
