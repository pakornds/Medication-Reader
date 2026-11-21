"""Catalogue-supported identity for display on a source-linked scan."""
from pydantic import Field

from app.schemas.evidence import ContractModel, EvidenceRef, Text


class CatalogueIdentity(ContractModel):
    ingredient: Text
    trade_name: Text | None
    release: Text
    candidate_tpus: list[Text] = Field(min_length=1, max_length=16)
    evidence: list[EvidenceRef] = Field(min_length=1, max_length=1)
