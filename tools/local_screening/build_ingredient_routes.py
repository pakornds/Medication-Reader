"""Build a local index of unambiguous FEST ingredient-and-route ATC evidence."""

import argparse
import gzip
import json
from collections import defaultdict
from pathlib import Path

from build_catalog_mapping import digest, load_fest


def ingredient_routes(names, formulations):
    evidence = defaultdict(lambda: defaultdict(dict))
    incomplete = set()
    for (ingredients, form, route), records in formulations.items():
        if len(ingredients) != 1:
            continue
        key = (ingredients[0], route)
        for product_id, mapping in sorted(records):
            if not mapping:
                incomplete.add(key)
                continue
            (_, code), = mapping
            evidence[key][code].setdefault(form, product_id)
    by_substance = defaultdict(dict)
    blocked_routes = defaultdict(set)
    for (substance_id, route), options in evidence.items():
        if len(options) != 1:
            incomplete.add((substance_id, route))
            continue
        code, products = next(iter(options.items()))
        by_substance[substance_id][route] = {"atc": code, "products_by_form": products}
    for substance_id, route in incomplete:
        by_substance[substance_id].pop(route, None)
        blocked_routes[substance_id].add(route)
    ingredients, blocked = {}, {}
    for name, ids in names.items():
        if len(ids) != 1:
            blocked[name] = ["*"]
            continue
        substance_id, = ids
        if by_substance[substance_id]:
            ingredients[name] = by_substance[substance_id]
        if blocked_routes[substance_id]:
            blocked[name] = sorted(blocked_routes[substance_id])
    return ingredients, blocked


def build(source, destination):
    names, formulations, _ = load_fest(source)
    ingredients, blocked = ingredient_routes(names, formulations)
    result = {
        "format_version": 1,
        "fest_sha256": digest(source),
        "ingredients": ingredients,
        "blocked": blocked,
    }
    data = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    with destination.open("wb") as output, gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as gz:
        gz.write(data.encode("utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path, help="Output ingredient-routes.json.gz")
    args = parser.parse_args()
    build(args.archive, args.output)
