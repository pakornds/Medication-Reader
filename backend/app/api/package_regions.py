from collections.abc import Callable

from fastapi import APIRouter, HTTPException

from app.ai.client import OpenAIClient, ProviderError
from app.schemas.review import ServiceError
from app.services.package_regions import (
    PackageRegionRequest, PackageRegionResult, SupersededView, propose_package_regions,
)


def create_package_regions_router(get_provider: Callable[[], OpenAIClient]) -> APIRouter:
    router = APIRouter(tags=["package regions"])

    @router.post("/packages/propose-regions", response_model=PackageRegionResult)
    def propose(request: PackageRegionRequest) -> PackageRegionResult:
        try:
            return propose_package_regions(request, get_provider)
        except SupersededView as exc:
            error = ServiceError(code="superseded_view", message=str(exc), recoverable=True)
            raise HTTPException(409, detail=error.model_dump(mode="json")) from None
        except ValueError as exc:
            error = ServiceError(code="invalid_display_image", message=str(exc), recoverable=True)
            raise HTTPException(422, detail=error.model_dump(mode="json")) from None
        except ProviderError as exc:
            status = 502 if exc.detail.code == "provider_invalid_output" else 503
            raise HTTPException(status, detail=exc.detail.model_dump(mode="json")) from None

    return router
