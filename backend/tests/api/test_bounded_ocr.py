"""Synthetic pixel oracle for the bounded OCR API and admission browser action."""
import json
import os
import socket
import subprocess
from io import BytesIO
from pathlib import Path
from threading import Thread

import pytest
import uvicorn
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.main import create_app
from app.schemas.analysis import AnalysisResult


def png(image):
    stream = BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class AdjacentLabels:
    def __init__(self):
        self.photo = Image.new("RGB", (800, 100), "white")
        self.labels = []
        draw = ImageDraw.Draw(self.photo)
        for index, (name, strength, directions) in enumerate([
            ("Fictional A", "5 mg", "Once each morning"),
            ("Fictional B / Fictional C", "10 mg", "Twice daily"),
            (None, None, None),
        ]):
            left = index * 200
            names = [name] if name else []
            if index == 0:
                names.append("Alternate name A")
            if name:
                wording = "\n".join([*names, strength, directions])
                draw.multiline_text((left + 10, 10), wording, fill="black")
            else:
                draw.rectangle((left, 0, left + 199, 99), fill="gray")
            pixels = self.photo.crop((left, 0, left + 200, 100)).tobytes()
            self.labels.append((pixels, names, strength, directions))
        self.seen = []

    def generate(self, *, evidence_text, images, output_type, **kwargs):
        manifest = json.loads(evidence_text)
        if output_type.__name__ == "LabelDirectionsChoices":
            assert not images
            return output_type()
        if "items" not in manifest:
            assert not images
            return output_type(case_id=manifest["evidence"]["case_id"], rows=manifest["label_transcripts"])
        image, = images
        received = Image.open(BytesIO(image.content))
        assert received.size == (200, 100)
        _, names, strength, directions = next(label for label in self.labels if label[0] == received.tobytes())
        item, = manifest["items"]
        ref = {"source_id": item["source_id"], "item_id": item["id"]}
        self.seen.append((names, item["row_id"], ref))
        fields = {
            key: {"status": "readable" if value else "unreadable", "value": value, "evidence": ref}
            for key, value in [("strength", strength), ("directions", directions)]
        }
        return AnalysisResult(case_id=manifest["case_id"], rows=[{
            "id": item["row_id"], "sources": [ref], "identity_status": "named" if names else "unreadable",
            "unknown_label": None if names else "Unknown medication C",
            "observed_names": [{"value": name, "evidence": ref} for name in names], "label_fields": fields,
        }])


def test_shared_attachment_uses_each_isolated_crop():
    oracle = AdjacentLabels()
    items = [
        {"id": name, "source_id": "photo", "row_id": name, "kind": "label_region"} for name in ["A", "B", "C"]
    ]
    form = {
        "evidence": {"case_id": "synthetic", "sources": [{"id": "photo", "kind": "label_photo"}], "items": items},
        "photo_source_ids": ["photo"], "region_locations": {"photo": {
            name: f"{index * 25}%,0%,25%,100%" for index, name in enumerate("ABC")
        }},
    }
    with TestClient(create_app(get_provider=lambda: oracle)) as client:
        response = client.post("/medication-analysis", files=[
            ("form", (None, json.dumps(form), "application/json")),
            ("photos", ("table.png", png(oracle.photo), "image/png")),
        ])
    assert response.status_code == 200, response.text
    first, second, third = response.json()["rows"]
    assert first["observed_names"] == [
        {"value": name, "evidence": {"source_id": "photo", "item_id": "A"}}
        for name in ["Fictional A", "Alternate name A"]
    ]
    assert second["observed_names"] == [
        {"value": "Fictional B / Fictional C", "evidence": {"source_id": "photo", "item_id": "B"}}
    ]
    for row, (strength, directions) in zip([first, second], [("5 mg", "Once each morning"), ("10 mg", "Twice daily")]):
        for field, expected in [("strength", strength), ("directions", directions)]:
            assert row["label_fields"][field] == {
                "status": "readable", "value": expected, "evidence": {"source_id": "photo", "item_id": row["id"]},
            }
    assert third["label_fields"]["strength"]["status"] == "unreadable"
    assert not third["observed_names"]


@pytest.mark.skipif(os.environ.get("RUN_BOUNDED_OCR_BROWSER") != "1", reason="opt-in Playwright browser check")
def test_admission_scan_action(tmp_path, monkeypatch):
    oracle = AdjacentLabels()
    fixture = tmp_path / "synthetic-table.png"
    fixture.write_bytes(png(oracle.photo))
    monkeypatch.setenv("MEDICATION_READER_DEMO_NURSE_TOKEN", "fixture-nurse")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(create_app(get_provider=lambda: oracle), log_level="error"))
        thread = Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        thread.start()
        try:
            runner = Path(__file__).parents[3] / "tests/integration/bounded-ocr.cjs"
            subprocess.run(["node", str(runner), str(port), str(fixture)], check=True, timeout=60)
        finally:
            server.should_exit = True
            thread.join(5)
    assert [names for names, _, _ in oracle.seen] == [
        ["Fictional A", "Alternate name A"],
        ["Fictional A", "Alternate name A"],
        ["Fictional B / Fictional C"],
        [],
    ]
    assert len({ref["source_id"] for _, _, ref in oracle.seen}) == 4
