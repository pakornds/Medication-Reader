from fastapi import Depends, HTTPException, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.schemas.admission_intake import IntakeSubmission
from app.schemas.review import ReviewerIdentity
from app.services.admission_intake import save_intake


def register_intake(router, store, resolve_reviewer):
    @router.post("/intake")
    async def intake(request: Request, actor: ReviewerIdentity = Depends(resolve_reviewer)):
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 24_000_000:
                raise HTTPException(413, "Intake exceeds the upload limit.")
            body.extend(chunk)
        try:
            submission = IntakeSubmission.model_validate_json(bytes(body))
            return await run_in_threadpool(save_intake, store, actor, submission)
        except (ValueError, ValidationError):
            raise HTTPException(422, "Invalid intake evidence or fields.") from None
