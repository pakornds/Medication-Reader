from typing import Literal

from fastapi import FastAPI

app = FastAPI(title="Medication Reader")


@app.get("/health")
def health() -> dict[str, Literal["ok"]]:
    return {"status": "ok"}
