from typing import Literal

from pydantic import AwareDatetime, Field

from .evidence import ContractModel, Text
from .review import ReviewRow


class CheckRequest(ContractModel):
    kind: Literal["DDI", "DRP"]
    enabled: bool
    rows: list[ReviewRow]
    context: dict[str, str | int | float | bool] = Field(default_factory=dict)


class ReferenceVersion(ContractModel):
    name: Text
    version: Text


class CheckedScope(ContractModel):
    row_ids: list[Text] = Field(min_length=1)
    rule_id: Text | None = None


class CheckExclusion(ContractModel):
    scope: CheckedScope
    reason: Text


class CheckFinding(ContractModel):
    scope: CheckedScope
    source: ReferenceVersion
    description: Text


class CheckSummary(ContractModel):
    kind: Literal["DDI", "DRP"]
    status: Literal["not_run", "unavailable", "partial", "complete"]
    simulated: Literal[True] = True
    ran_at: AwareDatetime | None = None
    source: ReferenceVersion | None = None
    evaluated: list[CheckedScope] = Field(default_factory=list)
    excluded: list[CheckExclusion] = Field(default_factory=list)
    warnings: list[Text] = Field(default_factory=list)
    findings: list[CheckFinding] = Field(default_factory=list)
