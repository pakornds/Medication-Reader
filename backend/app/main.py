from typing import Literal

from fastapi import FastAPI

from app.api.regimens import router as regimen_router

app = FastAPI(title="Medication Reader")
app.include_router(regimen_router)


@app.get("/health")
def health() -> dict[str, Literal["ok"]]:
    return {"status": "ok"}
