"""Serve the browser-native review workspace when running from a source checkout."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

REVIEW_COMPONENTS = Path(__file__).resolve().parents[2] / "src/components/review"


def mount_review_workspace(app: FastAPI) -> None:
    workspace = REVIEW_COMPONENTS / "workspace"
    if workspace.is_dir():
        app.mount("/review", StaticFiles(directory=workspace, html=True), name="review")
        app.mount("/regimen-review", StaticFiles(directory=REVIEW_COMPONENTS), name="review-assets")
