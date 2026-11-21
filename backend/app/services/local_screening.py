"""Screen confirmed Thai product selections against immutable local reference releases."""

import hashlib
import json
import re
import sqlite3
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import combinations

from app.schemas.analysis import AnalysisResult, validate_analysis_result
from app.schemas.evidence import CaseEvidence, EvidenceRef, EvidenceValidationError
from app.schemas.local_screening import (
    CatalogueScreeningRequest, DDILookup, DuplicateLookup, Ingredient, IngredientRouteMatch, LocalScreeningRequest, LocalScreeningResult,
    Reference, RuleMatch, ScreenedPair, ScreenedRow,
)
from app.schemas.regimen import validate_regimen_evidence
from app.schemas.review import ReviewRow
from app.services.checks import STOPPED_WARNING, _traceable, use_exclusion
from app.services import ingredient_route_reference as ingredient_reference
from app.services.local_reference_db import open_reference


# Exact controlled values in the verified route field only. Codes are from FEST 7477.
# An unfamiliar value requires review. Never parse label prose or infer patient use from form.
FEST_ROUTES = {
    "oral": "53", "by mouth": "53", "ophthalmic": "52", "ocular": "52", "otic": "6",
    "nasal": "51", "intranasal": "51", "transdermal": "65", "sublingual": "63",
    "vaginal": "67", "rectal": "59", "intraperitoneal": "37", "inhalation": "11",
}
MAPPING_REASONS = {
    "ambiguous_or_missing_product_chain": "The product evidence does not resolve to a unique composition.",
    "missing_substance_links": "The TMT product has missing substance links.",
    "master_graph_disagreement": "The product's declared ingredients and constituent links disagree.",
    "complex_substance_needs_review": "A complex substance needs manual ingredient identification.",
    "inactive_or_missing_tpu": "The trade product is inactive or missing in this TMT release.",
    "legacy_reconfirmation_required": "The trade product requires confirmation in the current catalogue.",
    "no_exact_fest_substance": "At least one TMT ingredient has no exact FEST substance match.",
    "form_route_unmapped": "The verified product's form and catalogue route have no supported FEST mapping.",
    "no_exact_fest_product_form_route": "No FEST product matched the exact ingredients, form and catalogue route.",
    "component_atc_unsupported": "A combination or component could not be resolved to supported ingredient ATCs.",
    "ambiguous_atc": "More than one FEST ATC mapping fits this product.",
}


class ReferenceUnavailable(RuntimeError):
    pass


@dataclass
class Product:
    row: ScreenedRow
    ingredients: dict[str, str] = field(default_factory=dict)
    atcs: set[str] = field(default_factory=set)
    route_gap: bool = False
    catalogue_form_route: tuple[str, str] | None = None


def _independent_identity(row: ReviewRow, evidence: CaseEvidence, identity: EvidenceRef) -> bool:
    """A disputed physical item needs a new item-specific source outside the disputed attachments."""
    disputes = [item for item in row.discrepancies if item.field == "identity"]
    if not disputes:
        return True
    if identity.item_id is None:
        return False
    disputed_sources = {value.evidence.source_id for item in disputes for value in item.observed_values}
    attachments = {s.attachment_id for s in evidence.sources if s.id in disputed_sources and s.attachment_id}
    return all(
        s.id not in disputed_sources and s.attachment_id not in attachments
        for s in evidence.sources if s.id == identity.source_id
    )


def _eligibility(row: ReviewRow, evidence: CaseEvidence) -> str | None:
    verification = row.verification
    reason = use_exclusion(row)
    if reason:
        return reason
    if not verification.identity or not verification.normalized_medication_id:
        return "No verified product identity and TPU."
    if {d.id for d in row.discrepancies} != set(verification.resolved_discrepancies):
        return "An evidence discrepancy remains unresolved."
    try:
        validate_analysis_result(AnalysisResult(case_id=evidence.case_id, rows=[row]), evidence)
        for regimen in verification.regimens:
            validate_regimen_evidence(regimen, row.id, evidence)
    except EvidenceValidationError:
        return "The medication row has invalid case evidence."
    references = [verification.identity.evidence, *verification.evidence, *verification.regimen_references()]
    if not all(_traceable(ref, row.id, evidence) for ref in references):
        return "Reviewed identity or use lacks traceable evidence for this row."
    if not _independent_identity(row, evidence, verification.identity.evidence):
        return "Disputed identity requires independent, item-specific source evidence."
    return None


def _route_scope(row: ReviewRow, expected: str | None) -> tuple[str | None, bool]:
    verification = row.verification
    if verification.regimens:
        routes = [component.route for component in verification.regimens]
    else:
        routes = [verification.route.value if verification.route else None]
    for route in routes:
        if route is None:
            continue
        code = FEST_ROUTES.get(route.strip().casefold())
        if code is None or expected is None:
            return "The verified route cannot be compared with the catalogue route. Confirm applicability.", True
        if code != expected:
            return "The verified route differs from the catalogue route used for this ATC mapping. Confirm the formulation and actual route.", True
    if None in routes:
        return "Actual route is missing for at least one regimen. The lookup uses the selected product only.", False
    return None, False


def _resolve(
    tmt: sqlite3.Connection, evidence: CaseEvidence, row: ReviewRow, release: str, legacy_release: str,
    *, encounter: bool = False,
) -> Product:
    if encounter and not use_exclusion(row) and row.verification.identity:
        # The admission verifies a full label. Resolve only a unique exact catalogue
        # label, then apply the same release and change checks as a confirmed TPU.
        matches = tmt.execute(
            "SELECT tpu FROM product WHERE label = ? LIMIT 2", (row.verification.identity.value,)
        ).fetchall()
        code = matches[0]["tpu"] if len(matches) == 1 else None
        verified = row.verification.model_copy(update={"normalized_medication_id": code})
        row = row.model_copy(update={"verification": verified})
    label = row.unknown_label or next((item.value for item in row.observed_names), row.id)
    result = Product(ScreenedRow(row_id=row.id, label=label, reason=_eligibility(row, evidence)))
    if result.row.reason:
        return result
    verification = row.verification
    if verification.tmt_release not in (None, release, legacy_release):
        result.row.reason = "The verified product belongs to a different TMT release. Re-select it from the current catalogue."
        return result
    product = tmt.execute(
        "SELECT tpu, label, legacy_label, composition_status, ddi_status, legacy_status, fest_route FROM product WHERE tpu=?",
        (verification.normalized_medication_id,),
    ).fetchone()
    if product is None or product["legacy_status"] == "absent_in_snapshot":
        result.row.reason = "The TPU is unavailable in the current TMT release. Re-select an active product."
        return result
    if product["legacy_status"] == "clinical_fields_changed" and verification.tmt_release != release:
        result.row.reason = "Product identity, strength or form changed. Re-select from the current TMT catalogue to confirm the release."
        return result

    # Bind the exact label to the selected TPU and the release that supplied the label.
    # Old rows without a release may use a legacy label only when clinical fields agree.
    name = verification.identity.value
    current_match = verification.tmt_release in (None, release) and name == product["label"]
    legacy_match = (
        verification.tmt_release in (None, legacy_release)
        and product["legacy_status"] == "unchanged"
        and name == product["legacy_label"]
    )
    if not (current_match or legacy_match):
        result.row.reason = "The verified identity and TPU do not match the product label for the selected catalogue release."
        return result

    references = [verification.identity.evidence, *verification.evidence, *verification.regimen_references()]
    result.row.evidence = list({(ref.source_id, ref.item_id): ref for ref in references}.values())
    result.row.route_note, result.route_gap = _route_scope(row, product["fest_route"])
    return _attach_product(tmt, result, product)


def _attach_product(tmt, result, product):
    tpu = product["tpu"]
    result.row.tpu = tpu
    result.row.label = product["label"]
    result.row.composition_status = product["composition_status"]
    result.row.ddi_status = product["ddi_status"]
    result.ingredients = dict(tmt.execute("SELECT subs_id,name FROM ingredient WHERE tpu=?", (tpu,)))
    result.atcs = {r[0] for r in tmt.execute("SELECT atc FROM product_atc WHERE tpu=?", (tpu,))}
    return result


def _duplicate(left: Product, right: Product) -> DuplicateLookup:
    reasons = [
        f"{p.row.row_id}: {p.row.reason or MAPPING_REASONS.get(p.row.composition_status, 'Complete TMT ingredient identities are unavailable.')}"
        for p in (left, right)
        if p.row.reason or p.row.composition_status != "complete" or not p.ingredients
    ]
    if reasons:
        return DuplicateLookup(status="unassessed", reasons=reasons)
    shared = sorted(left.ingredients.keys() & right.ingredients.keys())
    return DuplicateLookup(
        status="potential" if shared else "lookup_complete",
        reasons=["Both products list the same TMT substance ID. Confirm whether both products are intended."] if shared else
                ["The recorded TMT substance IDs do not overlap. Constituents without separate codes, salt equivalents and therapeutic-class duplication are outside this check."],
        ingredients=[Ingredient(subs_id=code, name=left.ingredients[code]) for code in shared],
    )


def _atc_hierarchy(code: str) -> set[str]:
    # WHO ATC levels are one, three, four, five and seven characters.
    return {code[:length] for length in (1, 3, 4, 5, 7)}


@dataclass
class Membership:
    sides: dict[str, dict[int, set[str]]] = field(default_factory=dict)
    gaps: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _members(fest: sqlite3.Connection, product: Product, unassessed: set[str]) -> Membership:
    matches = Membership()
    if product.row.reason or product.row.ddi_status != "mapped" or not product.atcs:
        reason = MAPPING_REASONS.get(product.row.ddi_status)
        if product.row.ddi_status == "composition_unresolved":
            reason = MAPPING_REASONS.get(product.row.composition_status, "The product's ingredient composition is unresolved.")
        matches.gaps.append(product.row.reason or reason or "A complete product-to-FEST ATC mapping is unavailable.")
        return matches
    if product.row.route_note:
        if product.route_gap:
            matches.gaps.append(product.row.route_note)
        else:
            matches.notes.append(product.row.route_note)
    for code in sorted(product.atcs):
        if not re.fullmatch(r"[A-Z]\d{2}[A-Z]{2}\d{2}", code):
            matches.gaps.append(f"{code} is not a supported full ATC code.")
            continue
        levels = _atc_hierarchy(code)
        # FEST §8.5 marks specific codes. §8.1's class expansion applies only to
        # positive interaction groups. An unassessed marker never erases an explicit rule.
        if code in unassessed:
            matches.gaps.append(f"FEST explicitly marks {code} as unassessed.")
        params = tuple(sorted(levels))
        rows = fest.execute(
            "SELECT rule_id,side,atc FROM atc_member WHERE atc IN (?,?,?,?,?)", params
        )
        for rule_id, side, atc in rows:
            matches.sides.setdefault(rule_id, {}).setdefault(side, set()).add(atc)
    return matches


def _read_rule(fest: sqlite3.Connection, rule_id: str, matched: tuple[list[str], list[str]]) -> RuleMatch:
    row = fest.execute("SELECT * FROM rule WHERE id=?", (rule_id,)).fetchone()
    if row is None:
        raise ReferenceUnavailable("The local FEST index has an incomplete rule.")
    node = ET.fromstring(row["entry_xml"]).find("{*}Interaksjon")
    if node is None:
        raise ReferenceUnavailable("The local FEST rule XML is incomplete.")
    basis = node.find("{*}Kildegrunnlag")
    refs = fest.execute(
        "SELECT citation_no,url FROM citation WHERE rule_id=? ORDER BY rowid", (rule_id,)
    )
    return RuleMatch(
        rule_id=rule_id, relevance=row["relevance_no"], consequence=row["clinical_consequence_no"],
        condition=node.findtext("{*}Situasjonskriterium"), mechanism=node.findtext("{*}Interaksjonsmekanisme"),
        source_basis=basis.get("DN") if basis is not None else None, updated=row["updated"],
        references=[Reference(title=r[0], url=r[1]) for r in refs], matched_atcs=matched,
    )


def _ddi(fest: sqlite3.Connection, left: Membership, right: Membership) -> DDILookup:
    reasons = [f"{side}: {reason}" for side, member in (("First row", left), ("Second row", right)) for reason in member.gaps]
    interactions = []
    for rule_id in sorted(left.sides.keys() & right.sides.keys()):
        matched_left, matched_right = set(), set()
        for side in (1, 2):
            left_codes = left.sides[rule_id].get(side, set())
            right_codes = right.sides[rule_id].get(3 - side, set())
            if left_codes and right_codes:
                matched_left.update(left_codes)
                matched_right.update(right_codes)
        if matched_left:
            interactions.append(_read_rule(fest, rule_id, (sorted(matched_left), sorted(matched_right))))
    if reasons:
        status = "partial" if interactions else "unassessed"
    elif any(r.relevance != "Ingen tiltak nødvendig" for r in interactions):
        status = "potential"
    else:
        status = "lookup_complete"
    if any(rule.condition for rule in interactions):
        reasons.append("A matched rule contains a source-specific situation criterion. Confirm it before applying the source assessment.")
    if interactions:
        reasons.append("Review the source relevance, route, actual overlapping exposure and all stated conditions; patient-specific applicability is unconfirmed.")
    elif not reasons:
        reasons.append("No opposing-group rule matched the mapped ATCs in this FEST release. The reference and lookup have limited coverage.")
    reasons.extend(f"{side}: {note}" for side, member in (("First row", left), ("Second row", right)) for note in member.notes)
    return DDILookup(status=status, interactions=interactions, reasons=reasons)


def _ingredient_route_rule(
    fest: sqlite3.Connection, left: Product, right: Product, meta: dict[str, str], fest_sha: str,
) -> RuleMatch | None:
    if (meta["tmt_release"], fest_sha) != (ingredient_reference.TMT_RELEASE, ingredient_reference.FEST_SHA256):
        return None
    products = (left, right)
    if not any(product.row.ddi_status == "no_exact_fest_product_form_route" for product in products):
        return None
    if any(product.row.reason or product.row.composition_status != "complete"
           or product.row.ddi_status not in {"mapped", "no_exact_fest_product_form_route"}
           for product in products):
        return None
    if left.catalogue_form_route is None or right.catalogue_form_route is None:
        return None

    doxy, iron = ingredient_reference.DOXYCYCLINE, ingredient_reference.FERROUS_FUMARATE
    for first, second in ((doxy, iron), (iron, doxy)):
        if first.matches(left.ingredients, *left.catalogue_form_route) and second.matches(
            right.ingredients, *right.catalogue_form_route
        ):
            break
    else:
        return None

    rule_id = ingredient_reference.RULE_ID
    opposite_sides = fest.execute(
        """SELECT 1 FROM atc_member AS a JOIN atc_member AS b
        ON a.rule_id = b.rule_id AND a.side <> b.side
        WHERE a.rule_id = ? AND a.atc = ? AND b.atc = ? LIMIT 1""",
        (rule_id, first.atc, second.atc),
    ).fetchone()
    if not opposite_sides:
        return None
    rule = _read_rule(fest, rule_id, ([first.atc], [second.atc]))
    if rule.relevance != "Forholdsregler bør tas":
        return None

    rule.ingredient_route_match = IngredientRouteMatch(
        route="oral",
        mapping_version=ingredient_reference.MAPPING_VERSION,
        summary_en="Iron can reduce doxycycline absorption when taken together.",
        summary_th="ธาตุเหล็กอาจลดการดูดซึมด็อกซีไซคลินเมื่อรับประทานพร้อมกัน",
        references=[
            Reference(title=f"WHO ATC/DDD Index · {entry.ingredient} ({entry.atc})", url=entry.reference_url)
            for entry in (first, second)
        ],
    )
    return rule


def _ddi_report(products: list[Product], meta: dict[str, str]) -> tuple[str, str, list[DDILookup]]:
    with open_reference("LOCAL_FEST_DB") as fest:
        source = fest.execute("SELECT sha256,archive_filename FROM source").fetchone()
        if source is None or not meta.get("fest_sha256") or source["sha256"] != meta["fest_sha256"]:
            raise ReferenceUnavailable("The TMT-to-FEST mapping and FEST index are from different releases.")
        unassessed = set()
        for raw, in fest.execute("SELECT entry_xml FROM unassessed"):
            node = ET.fromstring(raw).find("{*}InteraksjonIkkeVurdert/{*}Atc")
            if node is None or not node.get("V"):
                raise ReferenceUnavailable("The unassessed FEST scope could not be read.")
            unassessed.add(node.get("V"))
        members = [_members(fest, product, unassessed) for product in products]
        results = []
        for i, j in combinations(range(len(products)), 2):
            result = _ddi(fest, members[i], members[j])
            fallback = _ingredient_route_rule(fest, products[i], products[j], meta, source["sha256"])
            if fallback:
                result.interactions.append(fallback)
                result.status = "partial"
                result.reasons.append("The ingredient-and-oral-route rule matched. Exact product coverage remains incomplete.")
            results.append(result)
        return source["archive_filename"], source["sha256"], results


def screen_local(request: LocalScreeningRequest, *, encounter: bool = False) -> LocalScreeningResult:
    try:
        with open_reference("LOCAL_TMT_DB") as tmt:
            meta = dict(tmt.execute("SELECT key,value FROM metadata"))
            if not all(meta.get(key) for key in ("tmt_release", "legacy_tmt_release", "mapping_version", "mapping_sha256")):
                raise ReferenceUnavailable("The Thai product database has incomplete release metadata.")
            products = [
                _resolve(tmt, request.evidence, row, meta["tmt_release"], meta["legacy_tmt_release"], encounter=encounter)
                for row in request.rows
            ]
    except (sqlite3.Error, OSError) as exc:
        raise ReferenceUnavailable("The Thai product reference is missing or unreadable.") from exc

    warnings = [STOPPED_WARNING] if any(use_exclusion(row) == STOPPED_WARNING for row in request.rows) else []
    return _report(products, meta, request.model_dump(mode="json"), warnings)


def screen_catalogue_list(request: CatalogueScreeningRequest) -> LocalScreeningResult:
    products = []
    try:
        with open_reference("LOCAL_TMT_DB") as tmt:
            meta = dict(tmt.execute("SELECT key,value FROM metadata"))
            if not all(meta.get(key) for key in ("tmt_release", "mapping_version", "mapping_sha256")):
                raise ReferenceUnavailable("The Thai product database has incomplete release metadata.")
            for row in request.rows:
                result = Product(ScreenedRow(row_id=row.row_id, label=row.row_id))
                products.append(result)
                if not row.tpu or row.release != meta["tmt_release"]:
                    result.row.reason = "Choose a product from the current TMT release."
                    continue
                product = tmt.execute(
                    """SELECT tpu,label,composition_status,ddi_status,form,fest_route FROM product
                    WHERE tpu = ? AND active_tmt = 1""", (row.tpu,),
                ).fetchone()
                if not product:
                    result.row.reason = "The selected product is unavailable."
                    continue
                result.row.route_note = "Product-only lookup. Actual use and route were not assessed."
                if product["form"] and product["fest_route"]:
                    result.catalogue_form_route = (product["form"], product["fest_route"])
                _attach_product(tmt, result, product)
    except (sqlite3.Error, OSError) as exc:
        raise ReferenceUnavailable("The Thai product reference is missing or unreadable.") from exc
    return _report(products, meta, request.model_dump(mode="json"), [])


def _report(products, meta, snapshot_input, warnings):
    ddi_unavailable_reason = None
    fest_release = fest_sha = None
    pair_products = list(combinations(products, 2))
    try:
        fest_release, fest_sha, ddi_results = _ddi_report(products, meta)
    except (ReferenceUnavailable, sqlite3.Error, ET.ParseError, OSError) as exc:
        ddi_unavailable_reason = str(exc) if isinstance(exc, ReferenceUnavailable) else "The local FEST reference is missing or unreadable."
        ddi_results = [DDILookup(status="unassessed", reasons=[ddi_unavailable_reason]) for _ in pair_products]

    pairs = [
        ScreenedPair(row_ids=(left.row.row_id, right.row.row_id), ddi=ddi, duplicate=_duplicate(left, right))
        for (left, right), ddi in zip(pair_products, ddi_results, strict=True)
    ]
    snapshot_parts = [snapshot_input, meta["mapping_sha256"], meta["tmt_release"], fest_sha, ddi_unavailable_reason]
    ingredient_mapping_versions = {
        rule.ingredient_route_match.mapping_version
        for pair in pairs for rule in pair.ddi.interactions
        if rule.ingredient_route_match
    }
    if ingredient_mapping_versions:
        snapshot_parts.append(sorted(ingredient_mapping_versions))
    snapshot = json.dumps(snapshot_parts, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return LocalScreeningResult(
        snapshot_id=hashlib.sha256(snapshot.encode()).hexdigest(), tmt_release=meta["tmt_release"],
        fest_release=fest_release, mapping_version=meta["mapping_version"],
        ddi_unavailable_reason=ddi_unavailable_reason,
        ddi_scope="Product/form-based lookup using supported constituent ATCs and their FEST classes. Rules indexed solely by combination-product ATCs or substance names/IDs are outside this scope. Review actual route, dose, timing and exposure separately.",
        warnings=warnings,
        checked_at=datetime.now(UTC), rows=[p.row for p in products], pairs=pairs,
    )
