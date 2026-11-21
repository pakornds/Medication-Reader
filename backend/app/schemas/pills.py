from typing import Literal

from pydantic import Field

from .evidence import CaseEvidence, ContractModel, EvidenceRef, Observation, Text


class PillObservation(ContractModel):
    row_id: Text
    crop: EvidenceRef
    imprint: Observation
    shape: Observation
    form: Observation
    color: Observation
    overlapping: bool = False
    follow_up: Text | None = None


class CandidateRequest(ContractModel):
    evidence: CaseEvidence
    observation: PillObservation


class PillCandidate(ContractModel):
    reference_id: Text
    fictional_medication: Text
    image_reference: Text
    matches: list[Text]
    differences: list[Text]


class CandidateResult(ContractModel):
    row_id: Text
    status: Literal["unresolved"] = "unresolved"
    candidates: list[PillCandidate] = Field(default_factory=list)
    follow_up: Text
