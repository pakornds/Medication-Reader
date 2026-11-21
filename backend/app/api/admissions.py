from email import policy
from email.parser import BytesParser
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles

from starlette.concurrency import run_in_threadpool

from app.api.admission_intake import register_intake
from app.api.medication_analysis import MAX_FORM_BYTES, PHOTO_TYPES
from app.schemas.admission import Action, CaptureCommand, CaptureViewRequest, NewEncounter
from app.schemas.package_capture import RegionLink
from app.schemas.review import ReviewerIdentity
from app.services.admissions import AdmissionStore
from app.services.catalog import catalogue_choices


def register_admissions(app, hospital, resolve_reviewer):
    store = AdmissionStore(hospital)
    app.state.admissions = store
    router = APIRouter(prefix="/admissions", tags=["admission review"])
    reviewer = Depends(resolve_reviewer)
    register_intake(router, store, resolve_reviewer)

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

    @router.post("/{case_id}/capture", openapi_extra={"requestBody": {
        "required": True, "content": {"multipart/form-data": {"schema": {
            "type": "object", "required": ["command"], "properties": {
                "command": {"type": "string", "description": "JSON with revision, request_id, manifest, optional existing_rows, and optional replaces_view identifying the current view being retaken."},
                "front": {"type": "string", "format": "binary", "description": "Original front image on first upload or whole-view retake."},
                "reverse": {"type": "string", "format": "binary", "description": "Original reverse image on first upload or whole-view retake."},
            },
        }}},
    }})
    async def save_capture(case_id: str, request: Request, actor: ReviewerIdentity = reviewer):
        store.get(actor, case_id)
        content_type = request.headers.get("content-type", "")
        if (not content_type.lower().startswith("multipart/form-data;") or len(content_type) > 512
                or "\r" in content_type or "\n" in content_type):
            raise HTTPException(422, "Submit a capture form.")
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_FORM_BYTES:
                raise HTTPException(413, "Capture exceeds the upload limit.")
            body.extend(chunk)
        header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1")
        message = BytesParser(policy=policy.default).parsebytes(header + body)
        if not message.is_multipart() or message.defects:
            raise HTTPException(422, "Invalid capture form.")
        command, images = None, {}
        for part in message.iter_parts():
            side = part.get_param("name", header="Content-Disposition")
            payload = part.get_payload(decode=True)
            if not payload or part.defects or part.is_multipart() or part.get_content_disposition() != "form-data":
                raise HTTPException(422, "Invalid capture form part.")
            if side == "command" and command is None:
                try:
                    command = CaptureCommand.model_validate_json(payload)
                except ValueError:
                    raise HTTPException(422, "Invalid capture command or region reference.") from None
            elif side in {"front", "reverse"} and side not in images and part.get_content_type() in PHOTO_TYPES:
                images[side] = (part.get_content_type(), payload)
            else:
                raise HTTPException(422, "Supply one command and at most one original per view.")
        if command is None:
            raise HTTPException(422, "Supply a capture command.")
        return await run_in_threadpool(store.capture, actor, case_id, command, images)

    @router.post("/{case_id}/capture/view")
    def read_view(case_id: str, ref: CaptureViewRequest, actor: ReviewerIdentity = reviewer):
        image = store.view(actor, case_id, ref)
        return Response(content=image.content, media_type=image.media_type)

    @router.post("/{case_id}/capture/region")
    def read_region(case_id: str, link: RegionLink, actor: ReviewerIdentity = reviewer):
        image = store.region(actor, case_id, link)
        return Response(content=image.content, media_type=image.media_type)

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
