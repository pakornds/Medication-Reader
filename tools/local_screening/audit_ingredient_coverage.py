"""Measure offline FEST fallback coverage and optionally compare local DDInter CSVs."""

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path

from app.services.ingredient_route_reference import load_routes
from app.services.local_screening import _atc_hierarchy
from audit_rule_reach import reference
from build_catalog_mapping import norm


def catalogue(tmt, routes, release):
    products = tmt.execute("""
        SELECT tpu,composition_status,ddi_status,fest_form,fest_route FROM product WHERE active_tmt=1
    """).fetchall()
    ingredients = defaultdict(dict)
    for tpu, concept, name in tmt.execute("SELECT tpu,subs_id,name FROM ingredient"):
        ingredients[tpu][concept] = name
    exact = defaultdict(set)
    for tpu, atc in tmt.execute("""
        SELECT p.tpu,a.atc FROM product p JOIN product_atc a USING(tpu)
        WHERE p.active_tmt=1 AND p.ddi_status='mapped'
    """):
        exact[tpu].add(atc)
    fallback = {}
    singles = {}
    for tpu, composition, status, form, route in products:
        parts = ingredients[tpu]
        if composition == "complete" and len(parts) == 1:
            singles[tpu] = norm(next(iter(parts.values())))
        if form and route:
            candidate = routes.resolve(release=release, ingredients=parts, form_route=(form, route),
                                       composition_status=composition, ddi_status=status)
            if candidate and len(candidate.atcs) == 1:
                fallback[tpu] = set(candidate.atcs)
    return len(products), exact, fallback, singles


def actionable_membership(fest, atcs):
    codes_by_level = defaultdict(set)
    for code in atcs:
        for level in _atc_hierarchy(code):
            codes_by_level[level].add(code)
    matches = defaultdict(set)
    for rule, side, atc in fest.execute("""
        SELECT a.rule_id,a.side,a.atc FROM atc_member a JOIN rule r ON r.id=a.rule_id
        WHERE a.side IN (1,2) AND r.relevance_no <> 'Ingen tiltak nødvendig'
    """):
        for code in codes_by_level[atc]:
            matches[code].add((rule, side))
    return matches


def rule_sides(products, matches):
    sides = defaultdict(set)
    for tpu, codes in products.items():
        for code in codes:
            for rule_and_side in matches[code]:
                sides[rule_and_side].add(tpu)
    return sides


def can_reach(tpu, codes, matches, sides):
    return any(sides[(rule, 3 - side)] - {tpu} for code in codes for rule, side in matches[code])


def ddinter_audit(directory, single_names, products, matches):
    ids_by_name, candidate_pairs = defaultdict(set), set()
    expected = {f"ddinter_downloads_code_{code}.csv" for code in "ABDHLPRV"}
    for filename in sorted(expected):
        with (directory / filename).open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            if set(reader.fieldnames or []) != {"DDInterID_A", "Drug_A", "DDInterID_B", "Drug_B", "Level"}:
                raise ValueError(f"Unexpected DDInter CSV columns in {filename}")
            for row in reader:
                left, right = row["DDInterID_A"], row["DDInterID_B"]
                if not left or not right or not row["Drug_A"] or not row["Drug_B"] or not row["Level"]:
                    raise ValueError(f"Incomplete row in {filename}")
                ids_by_name[norm(row["Drug_A"])].add(left)
                ids_by_name[norm(row["Drug_B"])].add(right)
                if row["Level"] in {"Major", "Moderate"} and left != right:
                    candidate_pairs.add(tuple(sorted((left, right))))
    marketed_ids, atcs_by_id = set(), defaultdict(set)
    for tpu, name in single_names.items():
        ids = ids_by_name.get(name)
        if ids and len(ids) == 1:
            ddinter_id, = ids
            marketed_ids.add(ddinter_id)
            atcs_by_id[ddinter_id].update(products.get(tpu, ()))
    membership = {drug: set.union(set(), *(matches[code] for code in atcs)) for drug, atcs in atcs_by_id.items()}
    counts = Counter()
    for left, right in candidate_pairs:
        if left not in marketed_ids or right not in marketed_ids:
            continue
        if not atcs_by_id[left] or not atcs_by_id[right]:
            counts["at_least_one_ingredient_lacks_fest_atc"] += 1
        elif any((rule, 3 - side) in membership[right] for rule, side in membership[left]):
            counts["reachable_actionable_fest_rule"] += 1
        else:
            counts["both_have_atcs_but_no_actionable_fest_rule"] += 1
    return {"unique_major_or_moderate_pairs": len(candidate_pairs),
            "pairs_with_both_ingredients_in_tmt_by_exact_unique_name": sum(counts.values()),
            "tmt_pair_breakdown": dict(counts)}


def audit(tmt, fest, ddinter=None):
    metadata = dict(tmt.execute("SELECT key,value FROM metadata"))
    sha, = fest.execute("SELECT sha256 FROM source").fetchone()
    if sha != metadata["fest_sha256"]:
        raise ValueError("FEST release differs from the mapping release")
    routes = load_routes(sha)
    if routes is None:
        raise ValueError("No ingredient-route index for the selected FEST release")
    release = metadata["tmt_release"]
    count, exact, fallback, single_names = catalogue(tmt, routes, release)
    products = exact | fallback
    matches = actionable_membership(fest, {code for atcs in products.values() for code in atcs})
    baseline, expanded = rule_sides(exact, matches), rule_sides(products, matches)

    def reachable(sides):
        return {rule for (rule, side), left in sides.items()
                if side == 1 and left and (right := sides.get((rule, 2))) and len(left | right) > 1}

    result = {
        "tmt_release": release,
        "ingredient_route_mapping_version": routes.version,
        "active_products": count,
        "exact_product_atcs": len(exact),
        "additional_products_with_ingredient_atcs": len(fallback),
        "additional_products_with_at_least_one_actionable_fest_partner": sum(
            can_reach(tpu, codes, matches, expanded) for tpu, codes in fallback.items()
        ),
        "products_without_either_mapping": count - len(products),
        "actionable_rule_reach_before_fallback": len(reachable(baseline)),
        "actionable_rule_reach_after_fallback": len(reachable(expanded)),
    }
    if ddinter is not None:
        result["ddinter_exact_name_upper_bound"] = ddinter_audit(ddinter, single_names, products, matches)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tmt", type=Path)
    parser.add_argument("fest", type=Path)
    parser.add_argument("--ddinter-dir", type=Path, help="Optional directory with the eight official research CSVs")
    args = parser.parse_args()
    with reference(args.tmt) as tmt, reference(args.fest) as fest:
        print(json.dumps(audit(tmt, fest, args.ddinter_dir), indent=2))
