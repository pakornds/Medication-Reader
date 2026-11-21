"""Server-side transport for stateless, structured OpenAI Responses requests."""

import json
import os
from base64 import b64encode
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import BaseModel, ValidationError

from app.schemas.review import ServiceError

RESPONSES_URL = "https://api.openai.com/v1/responses"
Transport = Callable[[Request, float], bytes]


class ProviderError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.detail = ServiceError(code=code, message=message, recoverable=True)


@dataclass(frozen=True, slots=True)
class EvidenceImage:
    evidence_id: str
    media_type: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    content: bytes


def _send(request: Request, timeout: float) -> bytes:
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def _response_text(response: bytes) -> str:
    try:
        envelope = json.loads(response)
    except (UnicodeDecodeError, ValueError):
        raise ProviderError("provider_invalid_output", "Analysis returned invalid output.") from None
    if not isinstance(envelope, dict):
        raise ProviderError("provider_invalid_output", "Analysis returned invalid output.")
    if envelope.get("status") == "incomplete":
        raise ProviderError("provider_incomplete", "Analysis was incomplete. Retry the request.")
    if envelope.get("status") != "completed" or not isinstance(envelope.get("output"), list):
        raise ProviderError("provider_failure", "Analysis could not be completed.")

    parts: list[str] = []
    for item in envelope["output"]:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        content = item.get("content")
        if not isinstance(content, list):
            raise ProviderError("provider_invalid_output", "Analysis returned invalid output.")
        for entry in content:
            if not isinstance(entry, dict):
                raise ProviderError("provider_invalid_output", "Analysis returned invalid output.")
            if entry.get("type") == "refusal":
                raise ProviderError("provider_refusal", "Analysis could not process the evidence.")
            if entry.get("type") == "output_text" and isinstance(entry.get("text"), str):
                parts.append(entry["text"])
    if not parts:
        raise ProviderError("provider_invalid_output", "Analysis returned no structured output.")
    return "".join(parts)


class OpenAIClient:
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        timeout: float = 30.0,
        transport: Transport = _send,
    ) -> None:
        if not api_key.strip() or not model.strip():
            raise ProviderError("provider_unconfigured", "The analysis provider is not configured.")
        if timeout <= 0:
            raise ValueError("Timeout must be positive")
        self._api_key = api_key
        self.model = model
        self._timeout = timeout
        self._transport = transport

    @classmethod
    def from_environment(cls) -> "OpenAIClient":
        return cls(
            api_key=os.environ.get("OPENAI_API_KEY", ""),
            model=os.environ.get("OPENAI_MODEL", ""),
        )

    def generate[Output: BaseModel](
        self,
        *,
        instructions: str,
        evidence_text: str,
        output_type: type[Output],
        images: Sequence[EvidenceImage] = (),
    ) -> Output:
        content: list[dict[str, Any]] = [{"type": "input_text", "text": evidence_text}]
        for image in images:
            encoded = b64encode(image.content).decode("ascii")
            content.extend(
                [
                    {"type": "input_text", "text": f"Evidence source ID: {image.evidence_id}"},
                    {
                        "type": "input_image",
                        "image_url": f"data:{image.media_type};base64,{encoded}",
                        "detail": "high",
                    },
                ]
            )

        body = {
            "model": self.model,
            "store": False,
            "instructions": instructions,
            "input": [{"role": "user", "content": content}],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": output_type.__name__,
                    "schema": output_type.model_json_schema(),
                    # Pydantic also checks case-specific constraints outside the provider schema.
                    "strict": False,
                }
            },
        }
        request = Request(
            RESPONSES_URL,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        request.add_unredirected_header("Authorization", f"Bearer {self._api_key}")
        try:
            response = self._transport(request, self._timeout)
        except HTTPError as exc:
            if exc.code == 429:
                raise ProviderError("provider_rate_limited", "Analysis is temporarily busy.") from None
            raise ProviderError("provider_http_error", "The analysis provider rejected the request.") from None
        except OSError as exc:
            reason = exc.reason if isinstance(exc, URLError) else exc
            if isinstance(reason, TimeoutError):
                raise ProviderError(
                    "provider_timeout", "Analysis timed out. Retry with the same evidence."
                ) from None
            raise ProviderError(
                "provider_connection", "The analysis provider could not be reached."
            ) from None

        try:
            return output_type.model_validate_json(_response_text(response))
        except ValidationError:
            raise ProviderError(
                "provider_invalid_output", "Analysis returned invalid structured output."
            ) from None
