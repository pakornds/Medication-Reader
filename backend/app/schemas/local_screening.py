"""Read-only local reference screening, scoped to a reviewed medication snapshot."""

from typing import Literal

from pydantic import AwareDatetime, Field, model_validator

from .evidence import CaseEvidence, ContractModel, EvidenceRef, Text
from .review import ReviewRow


class CatalogueScreeningRow(ContractModel):
    row_id: Text
    tpu: Text | None = None
    release: Text | None = None


class CatalogueScreeningRequest(ContractModel):
    rows: list[CatalogueScreeningRow] = Field(max_length=100)

    @model_validator(mode="after")
    def unique_ids(self) -> "CatalogueScreeningRequest":
        if len({row.row_id for row in self.rows}) != len(self.rows):
            raise ValueError("Duplicate row IDs")
        return self


class LocalScreeningRequest(ContractModel):
    evidence: CaseEvidence
    rows: list[ReviewRow] = Field(max_length=100)

    @model_validator(mode="after")
    def unique_rows(self) -> "LocalScreeningRequest":
        if len({row.id for row in self.rows}) != len(self.rows):
            raise ValueError("Medication row IDs must be unique")
        return self


class ScreenedRow(ContractModel):
    row_id: str
    label: str
    tpu: str | None = None
    reason: str | None = None
    composition_status: str | None = None
    ddi_status: str | None = None
    route_note: str | None = None
    evidence: list[EvidenceRef] = Field(default_factory=list)


class Ingredient(ContractModel):
    subs_id: str
    name: str


class Reference(ContractModel):
    title: str | None
    url: str | None


class ClassificationSupport(ContractModel):
    total: int
    # Null means the medicine on this side has no alternative classification to choose.
    matches: list[tuple[str | None, str | None]]


class IngredientRouteMatch(ContractModel):
    route: Literal["oral"]
    mapping_version: str
    summary_en: str
    summary_th: str
    references: list[Reference]
    classification_uncertain: bool = False
    classification_support: ClassificationSupport | None = None


class RuleMatch(ContractModel):
    rule_id: str
    relevance: str
    consequence: str | None
    condition: str | None
    mechanism: str | None
    source_basis: str | None
    updated: str
    references: list[Reference]
    # Left/right follow the pair's row order, even if the FEST rule lists them in reverse.
    matched_atcs: tuple[list[str], list[str]]
    ingredient_route_match: IngredientRouteMatch | None = None


class DDILookup(ContractModel):
    status: Literal["potential", "lookup_complete", "partial", "unassessed"]
    reasons: list[str]
    interactions: list[RuleMatch] = Field(default_factory=list)


class DuplicateLookup(ContractModel):
    status: Literal["potential", "lookup_complete", "unassessed"]
    reasons: list[str]
    ingredients: list[Ingredient] = Field(default_factory=list)


class ScreenedPair(ContractModel):
    row_ids: tuple[str, str]
    ddi: DDILookup
    duplicate: DuplicateLookup


class LocalScreeningResult(ContractModel):
    snapshot_id: str
    tmt_release: str
    fest_release: str | None
    ddi_unavailable_reason: str | None
    ddi_scope: str
    mapping_version: str
    warnings: list[str] = Field(default_factory=list)
    checked_at: AwareDatetime
    rows: list[ScreenedRow]
    pairs: list[ScreenedPair]
