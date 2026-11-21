"""Read and explain a current synthetic report without relaying model prose."""

from collections.abc import Callable
from dataclasses import dataclass
from json import dumps
from typing import Literal

from fastapi import HTTPException

from app.ai.client import OpenAIClient, ProviderError
from app.ai.review_explanations import INSTRUCTIONS, Language, follow_up, render
from app.schemas.evidence import ContractModel, Text
from app.schemas.review import ReviewerIdentity
from app.schemas.review_scopes import ScreeningKind, ScreeningRelease, ScreeningRule, ScreeningScope
from app.services.admissions import AdmissionStore
from app.services.review_snapshots import ReviewSnapshotError, ReviewSnapshotStore, VersionedScreeningReport

SelectionPurpose = Literal["explain_finding", "explain_gap"]
RequestPurpose = Literal["explain_finding", "explain_gap", "clarify_scope", "treatment_request"]
Purpose = Literal["explain_finding", "explain_gap", "clarify_scope", "refer_to_reviewer"]
Origin = Literal["model_selection", "deterministic_fallback", "reviewer_referral"]
_SCREENING_ROLES = {"doctor", "pharmacist"}
_FINDING_TEMPLATES = {
    "demo-ddi-conditional-exposure": "confirmed-overlap-finding",
    "demo-duplicate-ingredient-v1": "shared-ingredient-finding",
}


class ExplanationRequest(ContractModel):
    snapshot_id: Text
    kind: ScreeningKind
    language: Language
    purpose: RequestPurpose
    item_id: Text | None = None


class ReviewSelection(ContractModel):
    snapshot_id: Text
    kind: ScreeningKind
    language: Language
    purpose: SelectionPurpose
    finding_ids: list[Text]
    exclusion_ids: list[Text]
    evidence_ids: list[Text]
    rule_ids: list[Text]
    follow_up_ids: list[Text]


class FollowUp(ContractModel):
    id: Text
    question: Text


class ReviewExplanation(ContractModel):
    snapshot_id: Text
    kind: ScreeningKind
    language: Language
    purpose: Purpose
    release_id: str | None
    mapping_version: str | None
    simulated: Literal[True] = True
    source: Origin
    template_id: Text
    finding_ids: list[Text]
    exclusion_ids: list[Text]
    evidence_ids: list[Text]
    rule_ids: list[Text]
    follow_up_ids: list[Text]
    follow_ups: list[FollowUp]
    explanation: Text


@dataclass(frozen=True)
class ReviewReadTools:
    """Read-only tools over the report and release fetched for one authorized encounter."""

    report: VersionedScreeningReport
    release: ScreeningRelease

    def get_check_summary(self, kind: ScreeningKind) -> dict:
        if kind != self.report.kind:
            raise ValueError("The check kind does not match the bound report.")
        return {
            "snapshot_id": self.report.snapshot_id, "kind": self.report.kind,
            "release_id": self.report.release_id, "mapping_version": self.report.mapping_version,
            "simulated": self.report.simulated, "status": self.report.status,
            "coverage": self.report.coverage.model_dump(),
            "evaluated_ids": [scope.scope_id for scope in self.report.scopes if scope.outcome != "unevaluated"],
            "finding_ids": [scope.scope_id for scope in self.report.scopes if scope.outcome == "finding"],
            "exclusions": {
                scope.scope_id: scope.reason_code for scope in self.report.scopes if scope.outcome == "unevaluated"
            },
        }

    def get_review_item(self, item_id: str) -> ScreeningScope:
        for item in self.report.scopes:
            if item.scope_id == item_id:
                return item
        raise ValueError("The item is unavailable in the bound report.")

    def get_rule_reference(self, rule_id: str) -> ScreeningRule:
        for item in self.report.scopes:
            if item.rule_id != rule_id:
                continue
            for rule in self.release.rules:
                if (rule.id, rule.kind, rule.version, rule.reference.source_section) == (
                    rule_id, self.report.kind, item.rule_version, item.reference_section
                ):
                    return rule
        raise ValueError("The rule is unavailable in the bound report.")


@dataclass(frozen=True)
class _Option:
    alias: str
    item: ScreeningScope
    template_id: str
    rule: ScreeningRule | None
    evidence_aliases: tuple[str, ...]
    rule_aliases: tuple[str, ...]
    follow_up_aliases: tuple[str, ...]
    follow_up_ids: tuple[str, ...]

    def matches(self, selection: ReviewSelection) -> bool:
        expected_findings = [self.alias] if self.item.outcome == "finding" else []
        expected_exclusions = [self.alias] if self.item.outcome == "unevaluated" else []
        return (
            selection.finding_ids == expected_findings
            and selection.exclusion_ids == expected_exclusions
            and sorted(selection.evidence_ids) == sorted(self.evidence_aliases)
            and sorted(selection.rule_ids) == sorted(self.rule_aliases)
            and sorted(selection.follow_up_ids) == sorted(self.follow_up_aliases)
        )


def _make_options(tools: ReviewReadTools, request: ExplanationRequest, summary: dict) -> list[_Option]:
    options = []
    release_questions = {entry.id: entry.question for entry in tools.release.follow_ups}
    ids = summary["finding_ids"] if request.purpose == "explain_finding" else summary["exclusions"]
    if request.item_id is not None:
        ids = [request.item_id] if request.item_id in ids else []
    for item_id in ids:
        item = tools.get_review_item(item_id)
        rule = tools.get_rule_reference(item.rule_id) if item.rule_id else None
        if request.purpose == "explain_finding":
            template_id = _FINDING_TEMPLATES.get(item.rule_id)
            if not rule or template_id is None:
                continue
            if template_id == "confirmed-overlap-finding" and not any(
                requirement.required_status == "confirmed" for requirement in rule.context_requirements
            ):
                continue
        else:
            template_id = {
                "unconfirmed_overlap": "overlap-gap",
                "stale_overlap": "overlap-timing-gap",
                "future_overlap": "overlap-timing-gap",
            }.get(item.reason_code, "scope-gap")
        index = len(options) + 1
        follow_up_ids = tuple(
            follow_up_id for follow_up_id in item.follow_up_ids
            if follow_up_id in release_questions
            and release_questions[follow_up_id] == follow_up(follow_up_id, "en")
        )
        options.append(_Option(
            alias=f"item-{index}", item=item, template_id=template_id, rule=rule,
            evidence_aliases=tuple(f"e-{index}-{n}" for n in range(1, len(item.evidence_ids) + 1)),
            rule_aliases=(f"rule-{index}",) if rule else (),
            follow_up_aliases=tuple(f"f-{index}-{n}" for n in range(1, len(follow_up_ids) + 1)),
            follow_up_ids=follow_up_ids,
        ))
    return options


def _tool_packet(request: ExplanationRequest, summary: dict, options: list[_Option]) -> str:
    # Model-facing citations are request-local aliases. Source IDs may contain user input.
    return dumps({
        "snapshot_id": request.snapshot_id,
        "kind": request.kind, "language": request.language, "purpose": request.purpose,
        "get_check_summary": {
            **{key: summary[key] for key in (
                "snapshot_id", "kind", "release_id", "mapping_version", "simulated", "status", "coverage",
            )},
            "finding_ids": [option.alias for option in options if option.item.outcome == "finding"],
            "excluded_ids": [option.alias for option in options if option.item.outcome == "unevaluated"],
        },
        "get_review_item": [{
            "item_id": option.alias, "outcome": option.item.outcome,
            "gap": option.template_id if option.item.outcome == "unevaluated" else None,
            "evidence_ids": option.evidence_aliases, "rule_ids": option.rule_aliases,
            "follow_up_ids": option.follow_up_aliases,
        } for option in options],
        "get_rule_reference": [{
            "rule_id": option.rule_aliases[0], "kind": option.rule.kind, "version": option.rule.version,
            "requires_overlap": bool(option.rule.context_requirements),
        } for option in options if option.rule],
    }, ensure_ascii=False)


def _build_response(
    request: ExplanationRequest,
    purpose: Purpose,
    source: Origin,
    template_id: str,
    report: VersionedScreeningReport | None = None,
    item: ScreeningScope | None = None,
    follow_up_ids: tuple[str, ...] = (),
) -> ReviewExplanation:
    follow_ups = []
    for follow_up_id in follow_up_ids:
        question = follow_up(follow_up_id, request.language)
        if question is not None:
            follow_ups.append(FollowUp(id=follow_up_id, question=question))
    values = {}
    if report and template_id == "scope-coverage":
        values = {
            "evaluated": report.coverage.evaluated_scopes, "total": report.coverage.total_scopes,
            "findings": report.coverage.findings, "excluded": report.coverage.excluded_scopes,
        }
    return ReviewExplanation(
        snapshot_id=request.snapshot_id, kind=request.kind, language=request.language,
        purpose=purpose, release_id=report.release_id if report else None,
        mapping_version=report.mapping_version if report else None,
        source=source, template_id=template_id,
        finding_ids=[item.scope_id] if item and item.outcome == "finding" else [],
        exclusion_ids=[item.scope_id] if item and item.outcome == "unevaluated" else [],
        evidence_ids=item.evidence_ids if item else [],
        rule_ids=[item.rule_id] if item and item.rule_id else [],
        follow_up_ids=[entry.id for entry in follow_ups], follow_ups=follow_ups,
        explanation=render(template_id, request.language, **values),
    )


class ReviewExplanationService:
    """Use the provider solely to select from an authorized deterministic report."""

    def __init__(
        self, admissions: AdmissionStore, snapshots: ReviewSnapshotStore,
        get_provider: Callable[[], OpenAIClient],
    ) -> None:
        self.admissions = admissions
        self.snapshots = snapshots
        self.get_provider = get_provider

    def explain(self, case_id: str, actor: ReviewerIdentity, request: ExplanationRequest) -> ReviewExplanation:
        if request.purpose == "treatment_request":
            return _build_response(request, "refer_to_reviewer", "reviewer_referral", "treatment-referral")
        tools = self._read(case_id, actor, request)
        if tools is None or tools.report.status == "not_run":
            return self._missing_report(request)
        summary = tools.get_check_summary(request.kind)
        coverage = _build_response(request, "clarify_scope", "deterministic_fallback", "scope-coverage", tools.report)
        if request.purpose == "clarify_scope":
            return coverage
        try:
            options = _make_options(tools, request, summary)
        except ValueError:
            return coverage
        if not options:
            return coverage

        selection = None
        try:
            selection = self.get_provider().generate(
                instructions=INSTRUCTIONS, evidence_text=_tool_packet(request, summary, options),
                output_type=ReviewSelection,
            )
        except ProviderError:
            pass

        # A provider call releases the encounter lock so admission edits can proceed.
        if self._read(case_id, actor, request) != tools:
            return self._missing_report(request)
        if not selection or (selection.snapshot_id, selection.kind, selection.language, selection.purpose) != (
            request.snapshot_id, request.kind, request.language, request.purpose
        ):
            return coverage
        option = next((candidate for candidate in options if candidate.matches(selection)), None)
        if option is None:
            return coverage
        return _build_response(
            request, request.purpose, "model_selection", option.template_id,
            tools.report, option.item, option.follow_up_ids
        )

    @staticmethod
    def _missing_report(request: ExplanationRequest) -> ReviewExplanation:
        return _build_response(request, "refer_to_reviewer", "reviewer_referral", "current-report-required")

    def _read(
        self, case_id: str, actor: ReviewerIdentity, request: ExplanationRequest
    ) -> ReviewReadTools | None:
        if actor.role not in _SCREENING_ROLES:
            return None
        with self.admissions.lock:
            try:
                case = self.admissions.get(actor, case_id)
                report = self.snapshots.get_report(case, request.snapshot_id, request.kind)
                release = self.snapshots.load_reference().release
                if (report.case_id, report.snapshot_id, report.kind, report.release_id, report.mapping_version) != (
                    case_id, request.snapshot_id, request.kind, release.id, release.mapping_version
                ):
                    return None
                if self.snapshots.get_report(case, request.snapshot_id, request.kind) != report:
                    return None
            except (HTTPException, ReviewSnapshotError):
                return None
        return ReviewReadTools(report, release)
