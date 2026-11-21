"""Rank reference presentations in the fixture-only pill catalog."""

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from app.schemas.pills import CandidateRequest, CandidateResult, PillCandidate, PillObservation

CATALOG_PATH = Path(__file__).resolve().parents[3] / "fixtures" / "catalog"
FEATURE_WEIGHTS = {"imprint": 4, "shape": 2, "form": 1, "color": 2}


@dataclass(frozen=True)
class Reference:
    id: str
    medication: str
    features: dict[str, str]
    silhouette: frozenset[tuple[int, int]]


def _pixels(silhouette: list[str]) -> frozenset[tuple[int, int]]:
    return frozenset(
        (x, y)
        for y, row in enumerate(silhouette)
        for x, pixel in enumerate(row)
        if pixel == "1"
    )


@cache
def _catalog() -> tuple[list[Reference], dict[tuple[str, str, str], frozenset]]:
    definitions = json.loads((CATALOG_PATH / "references.json").read_text(encoding="utf-8"))
    references = [
        Reference(
            id=entry["id"],
            medication=entry["medication"],
            features={feature: entry[feature] for feature in FEATURE_WEIGHTS},
            silhouette=_pixels(entry["silhouette"]),
        )
        for entry in definitions["references"]
    ]
    crops = {
        (crop["case_id"], crop["source_id"], crop["item_id"]): _pixels(crop["silhouette"])
        for crop in definitions["demo_crops"]
    }
    return references, crops


def catalogue_choices() -> list[dict[str, str]]:
    references, _ = _catalog()
    return [{"id": r.id, "name": r.medication} for r in references]


def reference_image(reference_id: str) -> Path | None:
    references, _ = _catalog()
    if any(reference.id == reference_id for reference in references):
        return CATALOG_PATH / f"{reference_id}.png"
    return None


def _observed_features(observation: PillObservation) -> dict[str, str]:
    features = {}
    for feature in FEATURE_WEIGHTS:
        value = getattr(observation, feature)
        if value.evidence is not None and value.evidence != observation.crop:
            raise ValueError("Each observation must cite the selected pill crop.")
        if value.status == "readable":
            features[feature] = value.value.casefold().strip()
    return features


def rank_candidates(request: CandidateRequest) -> CandidateResult:
    observation = request.observation
    crop = observation.crop
    if not any(
        item.id == crop.item_id
        and item.source_id == crop.source_id
        and item.row_id == observation.row_id
        and item.kind == "pill_crop"
        for item in request.evidence.items
    ):
        raise ValueError("The selected pill crop must belong to the case and row.")
    features = _observed_features(observation)
    if observation.overlapping:
        return CandidateResult(
            row_id=observation.row_id,
            follow_up="Separate the visible items and take a clearer photo.",
        )

    references, fixture_crops = _catalog()
    silhouette = fixture_crops.get((request.evidence.case_id, crop.source_id, crop.item_id))
    ranked = []
    for reference in references:
        matching = [
            feature for feature, value in features.items()
            if value == reference.features[feature].casefold()
        ]
        if "imprint" in features and "imprint" not in matching:
            continue
        similarity = (
            len(silhouette & reference.silhouette) / len(silhouette | reference.silhouette)
            if silhouette
            else 0
        )
        if not (set(matching) - {"form"}) and similarity < 0.7:
            continue
        score = sum(FEATURE_WEIGHTS[feature] for feature in matching) + 3 * similarity
        matches = [f"{feature}: {reference.features[feature]}" for feature in matching]
        if similarity >= 0.7:
            matches.append("similar silhouette")
        differences = [
            f"{feature}: observed {value}, reference {reference.features[feature]}"
            for feature, value in features.items()
            if feature not in matching
        ]
        candidate = PillCandidate(
            reference_id=reference.id,
            fictional_medication=reference.medication,
            image_reference=f"/pill-candidates/references/{reference.id}",
            matches=matches,
            differences=differences,
        )
        ranked.append((score, candidate))

    ranked.sort(key=lambda match: (-match[0], match[1].reference_id))
    return CandidateResult(
        row_id=observation.row_id,
        candidates=[candidate for _, candidate in ranked[:2]],
        follow_up="Ask for the original labeled package or dispensing record to verify identity.",
    )
