"""Run the normal FastAPI app with only label recognition supplied by the existing pixel fixture.

From the repository root, pass a temporary PNG path and local API port as arguments.
Point Vite's MEDREC_API_TARGET and the browser test's TEST_API_URL at that port.
Set SCENE_CAPTURE_ORACLE_PHOTO to the generated PNG for scene-capture-browser.cjs.
"""
from pathlib import Path
import sys

import uvicorn

repo = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(repo / "backend"), str(repo / "backend/tests/api")]

from app.main import create_app
from test_bounded_ocr import AdjacentLabels, png


if __name__ == "__main__":
    target, port = sys.argv[1:]
    oracle = AdjacentLabels()
    Path(target).write_bytes(png(oracle.photo))
    uvicorn.run(create_app(get_provider=lambda: oracle), host="127.0.0.1", port=int(port), access_log=False)
