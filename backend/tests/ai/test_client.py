import json
from pathlib import Path
from urllib.error import HTTPError, URLError

import pytest

from app.ai.client import RESPONSES_URL, EvidenceImage, OpenAIClient, ProviderError
from app.schemas.analysis import AnalysisResult

FIXTURE = Path(__file__).parents[1] / "fixtures" / "contracts" / "transfer_case.json"


def response_envelope(content: dict) -> bytes:
    return json.dumps(
        {"status": "completed", "output": [{"type": "message", "content": [content]}]}
    ).encode()


@pytest.fixture
def demo_response():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["response"]


def generate(client, images=()):
    return client.generate(
        instructions="Transcribe fictional evidence.",
        evidence_text="Synthetic case demo-transfer",
        output_type=AnalysisResult,
        images=images,
    )


def test_sends_stateless_structured_request(demo_response):
    def transport(request, timeout):
        assert request.full_url == RESPONSES_URL
        assert request.get_method() == "POST"
        assert request.get_header("Authorization") == "Bearer fixture-key"
        assert timeout == 3
        body = json.loads(request.data)
        assert body["model"] == "fixture-model"
        assert body["store"] is False
        assert "previous_response_id" not in body
        assert "fixture-key" not in request.data.decode()
        assert body["text"]["format"]["schema"] == AnalysisResult.model_json_schema()
        assert body["input"][0]["content"][1]["text"] == "Evidence source ID: label-photo"
        assert body["input"][0]["content"][2]["image_url"].startswith("data:image/png;base64,")
        return response_envelope({"type": "output_text", "text": json.dumps(demo_response)})

    client = OpenAIClient(
        api_key="fixture-key", model="fixture-model", timeout=3, transport=transport
    )
    response = generate(client, [EvidenceImage("label-photo", "image/png", b"fixture-bytes")])
    assert response.case_id == "demo-transfer"
    assert response.rows[0].observed_names[1].value == "Demo A"


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (TimeoutError("private fixture data"), "provider_timeout"),
        (URLError(TimeoutError("private fixture data")), "provider_timeout"),
        (URLError("private fixture data"), "provider_connection"),
        (HTTPError(RESPONSES_URL, 429, "private fixture data", {}, None), "provider_rate_limited"),
        (HTTPError(RESPONSES_URL, 403, "private fixture data", {}, None), "provider_http_error"),
    ],
)
def test_provider_errors_are_typed_and_sanitized(failure, code):
    def transport(_request, _timeout):
        raise failure

    client = OpenAIClient(api_key="fixture-key", model="fixture-model", transport=transport)
    with pytest.raises(ProviderError) as exc:
        generate(client)

    assert exc.value.detail.code == code
    assert exc.value.detail.recoverable is True
    assert "private fixture data" not in str(exc.value)
    assert "fixture-key" not in str(exc.value)


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (b"invalid JSON", "provider_invalid_output"),
        (b'{"status":"incomplete"}', "provider_incomplete"),
        (response_envelope({"type": "refusal", "refusal": "raw provider text"}), "provider_refusal"),
        (response_envelope({"type": "output_text", "text": "{}"}), "provider_invalid_output"),
    ],
)
def test_invalid_responses_are_recoverable(response, code):
    client = OpenAIClient(
        api_key="fixture-key", model="fixture-model", transport=lambda *_: response
    )
    with pytest.raises(ProviderError) as exc:
        generate(client)

    assert exc.value.detail.code == code
    assert exc.value.detail.recoverable is True


def test_configuration_uses_backend_environment(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_MODEL", "fixture-model")
    with pytest.raises(ProviderError, match="not configured"):
        OpenAIClient.from_environment()

    monkeypatch.setenv("OPENAI_API_KEY", "fixture-key")
    assert OpenAIClient.from_environment().model == "fixture-model"
