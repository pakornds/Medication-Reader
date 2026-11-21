"""Generate the preregistration contract: python -m app.schemas.openapi."""

import json

from pydantic.json_schema import models_json_schema

from .analysis import AnalysisRequest, AnalysisResult
from .checks import CheckRequest, CheckSummary
from .pills import CandidateRequest, CandidateResult, PillObservation
from .regimen import RegimenParseRequest, RegimenParseResult
from .review import ImportReceipt, ImportRequest, ReviewerIdentity, ServiceError


def contract_openapi() -> dict:
    models = (
        AnalysisRequest,
        AnalysisResult,
        RegimenParseRequest,
        RegimenParseResult,
        CandidateRequest,
        CandidateResult,
        CheckRequest,
        CheckSummary,
        ImportRequest,
        ImportReceipt,
        PillObservation,
        ReviewerIdentity,
        ServiceError,
    )
    _, schema = models_json_schema(
        [(model, "validation") for model in models],
        ref_template="#/components/schemas/{model}",
    )
    return {
        "openapi": "3.1.0",
        "info": {"title": "Medication Reader Reconciliation Contract", "version": "0.1.0"},
        "paths": {},
        "components": {"schemas": schema["$defs"]},
    }


if __name__ == "__main__":
    print(json.dumps(contract_openapi(), ensure_ascii=True, indent=2))
