from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException

from app.ai.client import OpenAIClient, ProviderError
from app.schemas.admission import CaptureViewRequest
from app.schemas.review import ReviewerIdentity, ServiceError
from app.services.admissions import AdmissionStore
from app.services.package_regions import PackageRegionResult, propose_package_regions


def create_package_regions_router(
    store: AdmissionStore, get_provider: Callable[[], OpenAIClient],
    resolve_reviewer: Callable[..., ReviewerIdentity],
) -> APIRouter:
    router = APIRouter(tags=["package regions"])

    @router.post("/admissions/{case_id}/capture/propose-regions", response_model=PackageRegionResult)
    def propose(
        case_id: str, view: CaptureViewRequest, actor: ReviewerIdentity = Depends(resolve_reviewer),
    ) -> PackageRegionResult:
        try:
            original = store.view(actor, case_id, view)
            bounds = propose_package_regions(original, get_provider)
            # The encounter can receive a retake while the provider is processing.
            store.view(actor, case_id, view)
        except HTTPException as exc:
            error = ServiceError(
                code="view_unavailable", message="Select a current capture view.", recoverable=True,
            )
            raise HTTPException(exc.status_code, detail=error.model_dump(mode="json")) from None
        except ProviderError as exc:
            status = 502 if exc.detail.code == "provider_invalid_output" else 503
            raise HTTPException(status, detail=exc.detail.model_dump(mode="json")) from None
        return PackageRegionResult(**view.model_dump(), case_id=case_id, regions=bounds.regions)

    return router
