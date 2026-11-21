"""Index a downloaded FEST human-prescriber archive locally. Uses the standard library."""

import argparse
import hashlib
import sqlite3
import tempfile
import xml.etree.ElementTree as ET
from contextlib import closing
from pathlib import Path
from zipfile import ZipFile

SCHEMA = """
CREATE TABLE source (publisher TEXT, archive_filename TEXT, sha256 TEXT, license_url TEXT);
CREATE TABLE rule (id TEXT PRIMARY KEY, source_entry TEXT UNIQUE, updated TEXT,
                   relevance_no TEXT, clinical_consequence_no TEXT, entry_xml TEXT NOT NULL);
CREATE TABLE atc_member (rule_id TEXT REFERENCES rule, side INTEGER, atc TEXT, name_no TEXT);
CREATE INDEX member_lookup ON atc_member(atc, rule_id, side);
CREATE TABLE citation (rule_id TEXT REFERENCES rule, citation_no TEXT, url TEXT);
CREATE INDEX citation_lookup ON citation(rule_id);
CREATE TABLE unassessed (source_entry TEXT PRIMARY KEY, entry_xml TEXT);
"""


def add_entry(db, entry):
    status = entry.find("{*}Status")
    if status is None or status.get("V") != "A":
        return
    key = entry.findtext("{*}Id")
    xml = ET.tostring(entry, encoding="unicode")
    rule = entry.find("{*}Interaksjon")
    if rule is None:
        if entry.find("{*}InteraksjonIkkeVurdert") is not None:
            db.execute("INSERT INTO unassessed VALUES (?, ?)", (key, xml))
        return
    rule_id = rule.findtext("{*}Id")
    db.execute("INSERT INTO rule VALUES (?, ?, ?, ?, ?, ?)", (
        rule_id, key, entry.findtext("{*}Tidspunkt"), rule.find("{*}Relevans").get("DN"),
        rule.findtext("{*}KliniskKonsekvens"), xml,
    ))
    for side, group in enumerate(rule.findall("{*}Substansgruppe"), 1):
        for atc in group.findall("{*}Substans/{*}Atc"):
            db.execute("INSERT INTO atc_member VALUES (?, ?, ?, ?)",
                       (rule_id, side, atc.get("V"), atc.get("DN")))
    for reference in rule.findall("{*}Referanse"):
        link = reference.find("{*}Lenke")
        db.execute("INSERT INTO citation VALUES (?, ?, ?)", (
            rule_id, reference.findtext("{*}Kilde"), link.get("V") if link is not None else None,
        ))


def build(archive, output):
    if archive.resolve() == output.resolve():
        raise ValueError("Choose different paths for the archive and database")
    with tempfile.TemporaryDirectory(dir=output.parent) as temp:
        staged = Path(temp) / "index.sqlite"
        with closing(sqlite3.connect(staged)) as db, ZipFile(archive) as zipped:
            db.execute("PRAGMA foreign_keys=ON")
            db.executescript(SCHEMA)
            with archive.open("rb") as data:
                digest = hashlib.file_digest(data, "sha256").hexdigest()
            db.execute("INSERT INTO source VALUES (?, ?, ?, ?)", (
                "Norwegian Medical Products Agency (DMP)", archive.name, digest,
                "https://data.norge.no/nlod/en/2.0",
            ))
            member, = [n for n in zipped.namelist() if n.lower().endswith(".xml")]
            with zipped.open(member) as xml:
                stack = []
                in_entry = False
                for event, node in ET.iterparse(xml, events=("start", "end")):
                    is_entry = node.tag.rsplit("}", 1)[-1] == "OppfInteraksjon"
                    if event == "start":
                        stack.append(node)
                        if is_entry:
                            in_entry = True
                        continue
                    if is_entry:
                        add_entry(db, node)
                        in_entry = False
                    stack.pop()
                    if stack and not in_entry:
                        stack[-1].remove(node)
            if not db.execute("SELECT 1 FROM rule LIMIT 1").fetchone():
                raise ValueError("No active FEST interaction records found")
            db.commit()
        staged.replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("database", type=Path)
    args = parser.parse_args()
    build(args.archive, args.database)
