"""Measure catalogue products that can reach an active FEST rule at both ends."""

import argparse
import json
import sqlite3
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path


def reference(path):
    return closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True))


def audit(tmt, fest):
    meta = dict(tmt.execute("SELECT key,value FROM metadata"))
    sha, = fest.execute("SELECT sha256 FROM source").fetchone()
    if sha != meta["fest_sha256"]:
        raise ValueError("FEST release differs from the mapping release")

    explicitly_unassessed = set()
    for raw, in fest.execute("SELECT entry_xml FROM unassessed"):
        atc = ET.fromstring(raw).find("{*}InteraksjonIkkeVurdert/{*}Atc")
        explicitly_unassessed.add(atc.attrib["V"])

    product_codes = defaultdict(set)
    for tpu, code in tmt.execute("""
        SELECT p.tpu, a.atc FROM product p JOIN product_atc a ON a.tpu=p.tpu
        WHERE p.ddi_status='mapped' AND p.active_tmt=1
    """):
        product_codes[tpu].add(code)
    groups = Counter(tuple(sorted(codes)) for codes in product_codes.values())

    # One group represents all Thai product codes with the same set of mapped ATCs.
    membership = defaultdict(set)
    eligibility = Counter()
    for group, count in groups.items():
        assessed = 0
        for code in group:
            hierarchy = {code[:n] for n in (1, 3, 4, 5, 7)}
            if code not in explicitly_unassessed:
                assessed += 1
            for level in hierarchy:
                membership[level].add(group)
        state = "all_codes" if assessed == len(group) else "some_codes" if assessed else "no_codes"
        eligibility[state] += count

    sides = defaultdict(lambda: (set(), set()))
    for rule, side, code in fest.execute("SELECT rule_id,side,atc FROM atc_member"):
        if code in membership:
            sides[rule][side - 1].update(membership[code])

    reachable = set()
    rule_count = 0
    for left, right in sides.values():
        if not left or not right:
            continue
        # A singleton group can be its own partner only if two distinct Thai TPUs exist.
        if len(left | right) == 1 and groups[next(iter(left))] < 2:
            continue
        rule_count += 1
        for first, second in ((left, right), (right, left)):
            if len(second) > 1:
                reachable.update(first)
            else:
                other, = second
                reachable.update(group for group in first if group != other or groups[group] > 1)
    return {
        "tmt_release": meta["tmt_release"], "fest_sha256": sha,
        "mapping_sha256": meta["mapping_sha256"],
        "mapped_active_products": sum(groups.values()),
        "distinct_atc_sets": len(groups),
        "mapped_products_by_atcs_without_an_exact_unassessed_notice": dict(eligibility),
        "distinct_active_rules": fest.execute("SELECT count(*) FROM rule").fetchone()[0],
        "rules_with_two_distinct_possible_thai_products": rule_count,
        "mapped_products_with_at_least_one_possible_rule_partner": sum(groups[g] for g in reachable),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tmt", type=Path)
    parser.add_argument("fest", type=Path)
    args = parser.parse_args()
    with reference(args.tmt) as tmt, reference(args.fest) as fest:
        print(json.dumps(audit(tmt, fest), indent=2))
