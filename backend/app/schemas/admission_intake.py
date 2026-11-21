"""An evidence-only draft handoff. Verification and import use ordinary admission actions."""
from typing import Literal
from uuid import UUID

from pydantic import Field

from app.schemas.analysis import MedicationSuggestion
from app.schemas.evidence import ContractModel, EvidenceItem, EvidenceSource, Text
from app.schemas.package_capture import RegionBounds


class IntakeProduct(ContractModel):
    tpu: Text
    label: Text
    active_tmt: bool
    strength: str
    dose_form: str
    source_generic: str | None = None


class IntakeChoice(ContractModel):
    product: IntakeProduct
    release: Text


class IntakePart(ContractModel):
    row: MedicationSuggestion
    origin: Literal['manual', 'analysis']
    catalogue: IntakeChoice | None = None
    sources: list[EvidenceSource]
    items: list[EvidenceItem]
    notes: dict[Text, Text]
    regions: dict[Text, RegionBounds]
    physical_items: dict[Text, Text]


class IntakeMedicine(IntakePart):
    linked: list[IntakePart] = Field(default_factory=list)
    corrections: dict[Literal["name", "strength", "form", "directions"], str] = Field(default_factory=dict)


class Original(ContractModel):
    media_type: Literal['image/jpeg', 'image/png', 'image/webp']
    data: str = Field(min_length=1, max_length=5_500_000)


class IntakeSubmission(ContractModel):
    case_id: UUID
    revision: int = Field(ge=0)
    current_views: dict[Literal["front", "reverse"], Text] = Field(default_factory=dict)
    rows: list[IntakeMedicine]
    originals: dict[Text, Original]
