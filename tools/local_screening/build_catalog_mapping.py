# /// script
# requires-python = ">=3.11"
# dependencies = ["xlrd==2.0.2"]
# ///
"""Build the local TMT-to-FEST mapping audit. See --help; input data stays outside Git."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sqlite3
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path
from zipfile import ZipFile

VERSION = "tmt-fest-form-route-2"
ATC_SYSTEM = "2.16.578.1.12.4.1.1.7180"
LEAF = re.compile(r"[A-Z][0-9]{2}[A-Z]{2}[0-9]{2}$")
# Explicit TMT form -> (FEST 7448 short pharmaceutical form, FEST 7477 route).
# The Norwegian tablet class includes conventional film-coated and coated tablets.
# Injection alone does not distinguish IV, IM, SC, etc. Do not guess a route.
FORM = {
    "tablet": ("53", "53"), "film-coated tablet": ("53", "53"), "coated tablet": ("53", "53"),
    "capsule, hard": ("891", "53"), "capsule, soft": ("890", "53"),
    "oral solution": ("842", "53"), "oral suspension": ("840", "53"), "syrup": ("14", "53"),
    "prolonged-release tablet": ("25", "53"), "gastro-resistant tablet": ("28", "53"),
    "orodispersible tablet": ("48", "53"), "chewable tablet": ("57", "53"),
    "effervescent tablet": ("16", "53"), "dispersible tablet": ("5", "53"),
    "gastro-resistant capsule, hard": ("769", "53"), "prolonged-release capsule, hard": ("743", "53"),
    "powder for oral suspension": ("224", "53"), "powder for oral solution": ("746", "53"),
    "granules for oral suspension": ("787", "53"), "granules for oral solution": ("786", "53"),
    "eye drops, solution": ("720", "52"), "eye drops, suspension": ("721", "52"),
    "eye ointment": ("94", "52"), "eye gel": ("91", "52"), "ear drops, solution": ("533", "6"),
    "nasal spray, solution": ("832", "51"), "nasal spray, suspension": ("833", "51"),
    "nasal drops, solution": ("807", "51"), "transdermal patch": ("58", "65"),
    "sublingual tablet": ("50", "63"), "vaginal tablet": ("120", "67"),
    "rectal solution": ("753", "59"), "solution for peritoneal dialysis": ("138", "37"),
    "inhalation powder, hard capsule": ("424", "11"),
    "inhalation powder, pre-dispensed": ("863", "11"),
    "pressurised inhalation, solution": ("860", "11"), "pressurised inhalation, suspension": ("861", "11"),
    "nebuliser solution": ("869", "11"), "nebuliser suspension": ("871", "11"),
}
COMPLEX = re.compile(r"\b(vaccin\w*|extracts?|multivitamins?|probiotics?|mixtures?|combinations?|allergens?)\b")
AGGREGATE_SUBSTANCES = {"vitamin b complex", "factor ix complex", "ossein mineral complex"}


def norm(text):
    return " ".join(unicodedata.normalize("NFC", text).casefold().split())


def digest(path):
    with path.open("rb") as data:
        return hashlib.file_digest(data, "sha256").hexdigest()


def workbook(path):
    import xlrd

    sheet = xlrd.open_workbook(str(path), logfile=io.StringIO()).sheet_by_index(0)
    headers = sheet.row_values(0)
    for i in range(1, sheet.nrows):
        values = sheet.row_values(i)
        if any(v != "" for v in values):
            yield dict(zip(headers, (str(v).strip() for v in values), strict=True))


def entries(archive):
    with ZipFile(archive) as z:
        member, = [name for name in z.namelist() if name.lower().endswith(".xml")]
        with z.open(member) as stream:
            stack = []
            for event, node in ET.iterparse(stream, events=("start", "end")):
                if event == "start":
                    node.tag = node.tag.rsplit("}", 1)[-1]
                    stack.append(node)
                    continue
                stack.pop()
                if node.tag.startswith("Oppf"):
                    if node.find("Status") is not None and node.find("Status").get("V") == "A":
                        yield node
                    stack[-1].remove(node)


def load_fest(archive):
    strength, substances, codebook, products = {}, {}, defaultdict(set), []
    release_stats = Counter()
    for entry in entries(archive):
        node = entry.find("Virkestoff")
        if node is not None:
            substances[node.findtext("Id")] = norm(node.findtext("NavnEngelsk") or "")
        node = entry.find("VirkestoffMedStyrke")
        if node is not None:
            combo_atc = node.find("AtcKombipreparat")
            strength[node.findtext("Id")] = (
                node.findtext("RefVirkestoff"), atc_value(combo_atc),
            )
        if entry.findtext("Info/Id") == ATC_SYSTEM:
            for element in entry.findall("Element"):
                for term in element.findall("Term"):
                    lang = term.find("Sprak")
                    if lang is not None and lang.get("V") == "EN":
                        codebook[element.findtext("Kode")].add(norm(term.findtext("Term") or ""))
        for tag in ("LegemiddelMerkevare", "LegemiddelVirkestoff"):
            node = entry.find(tag)
            if node is None:
                continue
            release_stats[tag] += 1
            form = node.find("LegemiddelformKort")
            routes = node.findall("AdministreringLegemiddel/Administrasjonsvei")
            refs = tuple(r.text for r in node.findall("SortertVirkestoffMedStyrke/RefVirkestoffMedStyrke"))
            if not refs or form is None:
                continue
            # Do not equate a multi-route FEST entry with a single-route reference.
            route_codes = {r.get("V") for r in routes if r.get("S") == "2.16.578.1.12.4.1.1.7477"}
            if len(route_codes) != 1 or form.get("S") != "2.16.578.1.12.4.1.1.7448":
                continue
            products.append((node.findtext("Id"), form.get("V"), route_codes.pop(), atc_value(node.find("Atc")), refs))
    if not products or not substances or not strength or not codebook:
        raise ValueError("Missing FEST product, substance, strength or English ATC catalogue")
    names = defaultdict(set)
    for key, name in substances.items():
        if name:
            names[name].add(key)
    # Index by the complete unordered *coded* ingredient set, exact form and sole route.
    index = defaultdict(set)
    for product, form, route, atc, refs in products:
        parts = [strength.get(ref, (None, None)) for ref in refs]
        ids = tuple(sorted(sid for sid, _ in parts if sid in substances))
        if len(ids) != len(parts) or len(set(ids)) != len(ids):
            continue
        if len(ids) == 1:
            codes = [(ids[0], atc)]
        else:
            codes = list(parts)
        # A full seven-character code can still describe a class/combination.
        # Accept an ingredient code only if its English ATC term identifies that exact substance.
        usable = all(code and LEAF.fullmatch(code) and codebook.get(code) == {substances[sid]}
                     for sid, code in codes)
        if usable and len(set(c for _, c in codes)) == len(ids):
            resolution = tuple(sorted((s, c) for s, c in codes))
        else:
            resolution = ()
        index[(ids, form, route)].add((product, resolution))
    return names, index, release_stats


def atc_value(node):
    return node.get("V") if node is not None and node.get("S") == ATC_SYSTEM else None


def tmt_composition(tpu, master_name, links, substances):
    identifiers = {tpu}
    for step in links[:-1]:
        if any(len(step.get(i, ())) != 1 for i in identifiers):
            return "ambiguous_or_missing_product_chain", []
        identifiers = set.union(*(step[i] for i in identifiers))
    vtm, = identifiers
    codes = sorted(links[-1].get(vtm, ()))
    if not codes or any(c not in substances for c in codes):
        return "missing_substance_links", []
    parts = [(c, substances[c]) for c in codes]
    # Validate official graph against an independent field of the same published catalogue.
    written = sorted(norm(s) for s in master_name.split(" + "))
    if sorted(norm(name) for _, name in parts) != written:
        return "master_graph_disagreement", parts
    if any(name in AGGREGATE_SUBSTANCES or COMPLEX.search(name) for name in written):
        return "complex_substance_needs_review", parts
    return "complete", parts


def resolve(composition_status, parts, form, names, index):
    if composition_status != "complete":
        return "composition_unresolved", [], []
    ids = []
    for _, name in parts:
        found = names.get(norm(name), set())
        if len(found) != 1:
            return ("fest_substance_ambiguous" if found else "no_exact_fest_substance"), [], []
        ids.extend(found)
    if form not in FORM:
        return "form_route_unmapped", [], []
    key = (tuple(sorted(ids)), *FORM[form])
    candidates = sorted(index.get(key, ()))
    if not candidates:
        return "no_exact_fest_product_form_route", [], []
    possibilities = {mapping for _, mapping in candidates}
    if not all(possibilities):
        return "component_atc_unsupported", [], candidates
    if len(possibilities) != 1:
        return "ambiguous_atc", [], candidates
    return "mapped", sorted(code for _, code in possibilities.pop()), candidates


def legacy_outcome(historical, comp, ddi):
    if historical == "clinical_fields_changed":
        return "legacy_reconfirmation_required", "legacy_reconfirmation_required"
    return comp, ddi


def write_csv(path, header, rows):
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


SCHEMA = """
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE product(tpu TEXT PRIMARY KEY,label TEXT NOT NULL,composition_status TEXT NOT NULL,
    ddi_status TEXT NOT NULL,form TEXT NOT NULL,fest_form TEXT,fest_route TEXT,
    active_tmt INTEGER NOT NULL,legacy_member INTEGER NOT NULL,legacy_status TEXT NOT NULL,
    source_strength TEXT NOT NULL,source_generic TEXT NOT NULL,legacy_label TEXT);
CREATE TABLE ingredient(tpu TEXT REFERENCES product,subs_id TEXT,name TEXT NOT NULL,PRIMARY KEY(tpu,subs_id));
CREATE TABLE product_atc(tpu TEXT REFERENCES product,atc TEXT,PRIMARY KEY(tpu,atc));
CREATE TABLE fest_evidence(tpu TEXT REFERENCES product,fest_product_id TEXT,mapping TEXT NOT NULL,
    PRIMARY KEY(tpu,fest_product_id));
CREATE INDEX ingredient_lookup ON ingredient(subs_id,tpu);
CREATE INDEX atc_lookup ON product_atc(atc,tpu);
"""


def build(tmt_root, release, legacy_file, fest, destination):
    digits = release.removeprefix("TMTRF")
    if not re.fullmatch(r"[0-9]{8}", digits):
        raise ValueError("TMT release must be its YYYYMMDD date")
    release = "TMTRF" + digits
    bonus = tmt_root / (release + "_BONUS")
    snapshot_path = tmt_root / release / (release + "_SNAPSHOT.xls")
    paths = {"tpu_snapshot": snapshot_path, "legacy_json": legacy_file, "fest_zip": fest}
    master_path = bonus / ("MasterTMT_" + digits + ".xls")
    paths["master"] = master_path
    links = []
    for parent, child in (("GPU", "TPU"), ("GP", "GPU"), ("VTM", "GP"), ("SUBS", "VTM")):
        alias = parent + "to" + child
        paths[alias] = bonus / "Relationship" / (alias + digits + ".xls")
        relation = defaultdict(set)
        for row in workbook(paths[alias]):
            relation[row[child + "ID"]].add(row[parent + "ID"])
        links.append(relation)
    paths["substances"] = bonus / "Concept" / ("SUBS" + digits + ".xls")
    substances = {r["TMTID(SUBS)"]: r["FSN"].removesuffix(" (SUBS)") for r in workbook(paths["substances"])}
    active = {r["TMTID(TPU)"]: r["FSN"] for r in workbook(snapshot_path)}
    master = {r["TPUCode"]: r for r in workbook(master_path)}
    old = json.loads(legacy_file.read_text("utf-8"))
    legacy = {r["tmt_id"]: r for r in old["medicines"]}
    if len(legacy) != len(old["medicines"]) or not active:
        raise ValueError("Empty active TMT snapshot or duplicate legacy TPU IDs")
    if not set(master).issuperset(active):
        raise ValueError("Active snapshot has TPUs missing from the release master")
    names, index, stats = load_fest(fest)
    hashes = {source: digest(path) for source, path in sorted(paths.items())}
    hashes["builder"] = digest(Path(__file__))
    fingerprint = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    meta = dict(tmt_release=release, fest_sha256=hashes["fest_zip"], mapping_version=VERSION,
                mapping_sha256=fingerprint, legacy_tmt_release=old["metadata"]["release"], source_files_json=json.dumps(hashes, sort_keys=True))
    counters = {k: defaultdict(Counter) for k in ("active", "legacy", "union")}
    product_csv = []
    header = ["tpu", "label", "active_tmt", "legacy_member", "legacy_status", "source_generic", "form",
              "source_strength", "composition_status", "ddi_status", "fest_form", "fest_route",
              "tmt_subs_ids", "atcs", "fest_candidate_count", "mapping_version", "tmt_release",
              "legacy_composition_status", "legacy_ddi_status", "legacy_label"]
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination) as temp:
        staged = Path(temp)
        with closing(sqlite3.connect(staged / "tmt-fest-mapping.sqlite")) as db:
            db.execute("PRAGMA foreign_keys=ON")
            db.executescript(SCHEMA)
            db.executemany("INSERT INTO metadata VALUES (?,?)", sorted(meta.items()))
            for tpu in sorted(active.keys() | legacy.keys(), key=int):
                legacy_item = legacy.get(tpu)
                current = master.get(tpu) if tpu in active else None
                if current:
                    label, generic, form, strength = (current[field] for field in ("FSN", "ActiveIngredient", "Dosageform", "Strength"))
                    comp, parts = tmt_composition(tpu, generic, links, substances)
                    if legacy_item is None:
                        historical = "new_to_legacy"
                    else:
                        old_fields = [legacy_item.get(k) or "" for k in ("generic_name", "dosage_form", "strength")]
                        historical = "unchanged" if list(map(norm, old_fields)) == list(map(norm, [generic, form, strength])) else "clinical_fields_changed"
                    ddi, atcs, evidence = resolve(comp, parts, norm(form), names, index)
                else:
                    label, generic, form = (legacy_item[k] for k in ("label", "generic_name", "dosage_form"))
                    strength = legacy_item.get("strength") or ""
                    historical = "absent_in_snapshot"
                    comp = ddi = "inactive_or_missing_tpu"
                    parts, atcs, evidence = [], [], []
                fr, route = FORM.get(norm(form), (None, None))
                legacy_label = legacy_item["label"] if legacy_item else None
                db.execute("INSERT INTO product VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           (tpu, label, comp, ddi, form, fr, route, bool(current), bool(legacy_item), historical, strength, generic, legacy_label))
                db.executemany("INSERT INTO ingredient VALUES (?,?,?)", [(tpu, s, name) for s, name in parts])
                db.executemany("INSERT INTO product_atc VALUES (?,?)", [(tpu, c) for c in atcs])
                db.executemany("INSERT INTO fest_evidence VALUES (?,?,?)",
                               [(tpu, p, json.dumps(m, separators=(",", ":"))) for p, m in evidence])
                old_comp, old_ddi = legacy_outcome(historical, comp, ddi)
                product_csv.append((tpu, label, int(bool(current)), int(bool(legacy_item)), historical, generic, form, strength,
                                    comp, ddi, fr, route, "|".join(s for s, _ in parts), "|".join(atcs), len(evidence), VERSION, release,
                                    old_comp if legacy_item else None, old_ddi if legacy_item else None, legacy_label))
                for scope in ["union"] + (["active"] if current else []) + (["legacy"] if legacy_item else []):
                    usable_comp, usable_ddi = (old_comp, old_ddi) if scope == "legacy" else (comp, ddi)
                    counts = counters[scope]
                    for key, val in [("products","all"),("composition",usable_comp),("ddi",usable_ddi),("legacy_status",historical)]:
                        counts[key][val] += 1
                    if usable_comp == "complete":
                        counts["complete_composition_size"]["single" if len(parts) == 1 else "multiple"] += 1
                    if usable_ddi == "mapped":
                        counts["mapped_composition_size"]["single" if len(parts) == 1 else "multiple"] += 1
            db.commit()
        report = {
            "mapping_version": VERSION, "tmt_release": release, "legacy_tmt_release": meta["legacy_tmt_release"],
            "fest_archive": fest.name,
            "mapping_sha256": fingerprint, "input_sha256": hashes, "counts": counters, "active_fest_records": stats,
        }
        (staged / "tmt-fest-coverage.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        write_csv(staged / "tmt-fest-products.csv", header, product_csv)
        write_csv(staged / "tmt-fest-coverage.csv", ["scope", "dimension", "status", "products"], (
            (scope, metric, status, value) for scope, counts in sorted(counters.items())
            for metric, counter in sorted(counts.items()) for status, value in sorted(counter.items())
        ))
        for item in sorted(staged.iterdir()):
            item.replace(destination / item.name)
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tmt-root", required=True, type=Path, help="Extracted release root containing the _BONUS directory")
    p.add_argument("--release", required=True)
    p.add_argument("--legacy", required=True, type=Path, help="The existing medicines.json export")
    p.add_argument("--fest", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()
    audit = build(args.tmt_root, args.release, args.legacy, args.fest, args.out)
    print(json.dumps(audit["counts"], indent=2, sort_keys=True))
