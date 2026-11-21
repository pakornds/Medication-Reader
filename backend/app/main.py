from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI

from app.ai.client import OpenAIClient
from app.api.feature_routes import register_feature_routes, resolve_demo_reviewer
from app.schemas.review import ReviewerIdentity
from app.services.hospital import MockHospital


def create_app(
    *,
    get_provider: Callable[[], OpenAIClient] = OpenAIClient.from_environment,
    resolve_reviewer: Callable[..., ReviewerIdentity] = resolve_demo_reviewer,
) -> FastAPI:
    hospital = MockHospital()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            yield
        finally:
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
