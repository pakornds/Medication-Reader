from collections.abc import Awaitable, Callable

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from app.ai.client import OpenAIClient, ProviderError
from app.schemas.pills import PillObservation
from app.schemas.review import ServiceError
from app.services.pills import PillCropError, PillObservationRequest, observe_pill_crops


class PillCropRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def handle(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError:
                detail = ServiceError(
                    code="invalid_pill_crop",
                    message="Provide valid crop references and Base64 images within the size limit.",
                    recoverable=True,
                )
                raise HTTPException(422, detail=detail.model_dump(mode="json")) from None

        return handle


def create_pills_router(
    get_provider: Callable[[], OpenAIClient] = OpenAIClient.from_environment,
) -> APIRouter:
    router = APIRouter(tags=["pill observations"], route_class=PillCropRoute)

    @router.post("/pills/observe", response_model=list[PillObservation])
    def observe(request: PillObservationRequest) -> list[PillObservation]:
        try:
            return observe_pill_crops(request, get_provider)
        except PillCropError as exc:
            detail = ServiceError(code="invalid_pill_crop", message=str(exc), recoverable=True)
            raise HTTPException(422, detail=detail.model_dump(mode="json")) from None
        except ProviderError as exc:
            status = 502 if exc.detail.code in {
                "provider_invalid_output", "unsupported_pill_evidence"
            } else 503
            raise HTTPException(status, detail=exc.detail.model_dump(mode="json")) from None

    return router
