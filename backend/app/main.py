import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI

from app.ai.client import OpenAIClient
from app.api.feature_routes import register_feature_routes, resolve_demo_reviewer
from app.schemas.review import ReviewerIdentity
from app.services.hospital import MockHospital


class _ReviewAccessFilter(logging.Filter):
    """Keep encounter locators and receipt query values out of Uvicorn access logs."""
    def filter(self, record):
        args = record.args
        if isinstance(args, tuple) and len(args) == 5:
            path = str(args[2]).split("?", 1)[0]
            if path == "/imports" or path.startswith(("/imports/", "/admissions/", "/admissions")):
                return False
        return True


def create_app(
    *,
    get_provider: Callable[[], OpenAIClient] = OpenAIClient.from_environment,
    resolve_reviewer: Callable[..., ReviewerIdentity] = resolve_demo_reviewer,
) -> FastAPI:
    hospital = MockHospital()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        access_log = logging.getLogger("uvicorn.access")
        review_filter = _ReviewAccessFilter()
        access_log.addFilter(review_filter)
        try:
            yield
        finally:
            access_log.removeFilter(review_filter)
            hospital.close()

    application = FastAPI(title="Medication Reader", lifespan=lifespan)

    @application.get("/health")
    def health() -> dict[str, Literal["ok"]]:
        return {"status": "ok"}

    register_feature_routes(
        application,
        hospital=hospital,
        get_provider=get_provider,
        resolve_reviewer=resolve_reviewer,
    )
    return application


app = create_app()
