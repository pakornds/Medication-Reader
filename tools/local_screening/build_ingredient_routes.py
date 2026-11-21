"""Build the FEST ingredient-route index using FEST and FDA terminology releases."""

import argparse
import csv
import gzip
import io
import json
from collections import defaultdict
from pathlib import Path
from zipfile import ZipFile

from build_catalog_mapping import LEAF, digest, load_fest, norm


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
        by_substance[substance_id][route] = options
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


def main_ingredient_links(names, therapeutic_parents):
    unique_names = {next(iter(ids)): name for name, ids in names.items() if len(ids) == 1}
    links = {}
    for precise_id, parents in therapeutic_parents.items():
        if len(parents) != 1 or precise_id not in unique_names:
            continue
        parent_id, = parents
        if parent_id in unique_names and parent_id != precise_id:
            links[unique_names[precise_id]] = {
                "target": unique_names[parent_id], "precise_id": precise_id, "parent_id": parent_id,
            }
    return links


def explicitly_oral_atcs(names, codebook):
    codes_by_name = defaultdict(set)
    for code, labels in codebook.items():
        if code and LEAF.fullmatch(code):
            for label in labels:
                codes_by_name[label].add(code)
    results = {}
    for name, ids in names.items():
        if len(ids) != 1 or len(codes_by_name[name]) != 1:
            continue
        code, = codes_by_name[name]
        if codebook[code] != {name}:
            continue
        for group in (code[:5], code[:4], code[:3]):
            labels = codebook.get(group, ())
            if len(labels) == 1 and next(iter(labels)).endswith(", oral preparations"):
                results[name] = {"atc": code, "group": group}
                break
    return results


def unii_aliases(archive, names):
    # Use exact official/common names and reject terms assigned to multiple UNIIs,
    # including conflicting occurrences under other name types.
    ids_by_name = {}
    eligible = set()
    with ZipFile(archive) as source:
        member, = [name for name in source.namelist() if Path(name).name.startswith("UNII_Names_")]
        with source.open(member) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as table:
            reader = csv.DictReader(table, delimiter="\t")
            if not {"NAME", "TYPE", "UNII"}.issubset(reader.fieldnames or ()):
                raise ValueError("Missing required FDA UNII names columns")
            for row in reader:
                name, unii = norm(row["NAME"]), row["UNII"].strip()
                if not name or not unii:
                    continue
                if ids_by_name.setdefault(name, unii) != unii:
                    ids_by_name[name] = None
                if row["TYPE"] in {"of", "cn"}:
                    eligible.add(name)
    fest_names_by_unii = defaultdict(set)
    for name, ids in names.items():
        if unii := ids_by_name.get(name):
            fest_names_by_unii[unii].update(ids)
    fest_targets = {}
    for name in names:
        if name in eligible and (unii := ids_by_name[name]) and len(fest_names_by_unii[unii]) == 1:
            fest_targets.setdefault(unii, name)
    aliases = {
        name: {"target": fest_targets[unii], "unii": unii}
        for name in eligible - names.keys()
        if (unii := ids_by_name[name]) in fest_targets
    }
    return aliases, Path(member).stem.removeprefix("UNII_Names_")


def build(source, destination, unii_archive):
    therapeutic_parents, codebook = {}, {}
    names, formulations, _ = load_fest(source, therapeutic_parents=therapeutic_parents, english_atc=codebook)
    ingredients, blocked = ingredient_routes(names, formulations)
    aliases, unii_release = unii_aliases(unii_archive, names)
    result = {
        "format_version": 2,
        "fest_sha256": digest(source),
        "unii_sha256": digest(unii_archive),
        "unii_release": unii_release,
        "ingredients": ingredients,
        "blocked": blocked,
        "parents": main_ingredient_links(names, therapeutic_parents),
        "aliases": aliases,
        "explicitly_oral": explicitly_oral_atcs(names, codebook),
    }
    data = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    with destination.open("wb") as output, gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as gz:
        gz.write(data.encode("utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path, help="Output ingredient-routes.json.gz")
    parser.add_argument("--unii-archive", type=Path, required=True, help="FDA UNIIs.zip release")
    args = parser.parse_args()
    build(args.archive, args.output, args.unii_archive)
