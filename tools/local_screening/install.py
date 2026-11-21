# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Install the two offline screening databases for this checkout."""
import argparse
import gzip
import json
import shutil
import sqlite3
from contextlib import closing
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import URLError
from urllib.request import urlopen
from zipfile import BadZipFile, ZipFile

from build_catalog_mapping import build, digest, workbook

REFERENCE_DIR = Path(__file__).resolve().parents[2] / "reference-data"
FEST_DIR = REFERENCE_DIR / "fest-20261111"
FEST_SOURCE = FEST_DIR / "FEST-prescriber-2.5.1-20261111.zip"
FEST_HASH = "cfca96f221b23864c06554e9723ce1336edf704ba17609d7c0694f81805c66f3"
INDEX_HASH = "fb24be3ff88395e731a5f60da97e4c13430664015cd7d55dcc4881e437615464"
MAPPING_HASH = "2119ca20409ed4d1a402c073068cedbf0687ee21c0dd66dbd797c9dd7121aeba"
PUBLIC_URL = ("https://data.go.th/dataset/ca6ec620-369c-4f56-a8d6-56f1541e5ddf/resource/"
              "b88ca253-d6e2-42f1-9162-95f929e6a5c3/download/thai-medicines-terminology-tmt-pjzk04.zip")
PUBLIC_HASH = "b7a1fe6719a422303a9fe5a7dadf476b8cd8b2a45e94386b25d77dfcc791ec91"
PUBLIC_RELEASE = "TMTRF20200217"
CURRENT_RELEASE = "TMTRF20261116"


def verify(path, expected):
    if digest(path) != expected:
        raise ValueError(f"SHA-256 mismatch for {path.name}; installation stopped")


def prepare_public(archive, root):
    """Copy only the required publisher workbooks into the mapper's release layout."""
    bonus = Path(PUBLIC_RELEASE + "_BONUS")
    master = bonus / "MasterTMT_20200217.xls"
    files = {
        "mastertmt-20200217-.xls": master,
        "tmtrf20200217-snapshot-.xls": Path(PUBLIC_RELEASE) / (PUBLIC_RELEASE + "_SNAPSHOT.xls"),
        "subs20200217-.xls": bonus / "Concept" / "SUBS20200217.xls",
    }
    for link in ("GPUtoTPU", "GPtoGPU", "VTMtoGP", "SUBStoVTM"):
        files[link.lower() + "20200217-.xls"] = bonus / "Relationship" / (link + "20200217.xls")
    with ZipFile(archive) as source:
        for member, relative in files.items():
            output = root / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            with source.open(member) as data, output.open("wb") as dest:
                shutil.copyfileobj(data, dest)
    legacy = root / "legacy.json"
    fields = {"tmt_id": "TPUCode", "label": "FSN", "generic_name": "ActiveIngredient",
              "dosage_form": "Dosageform", "strength": "Strength"}
    medicines = [{key: row[column] for key, column in fields.items()} for row in workbook(root / master)]
    legacy.write_text(json.dumps({"metadata": {"release": PUBLIC_RELEASE}, "medicines": medicines},
                                 ensure_ascii=False), encoding="utf-8")
    return legacy


def unpack(source, dest, checksum):
    with gzip.open(source, "rb") as data, dest.open("wb") as target:
        shutil.copyfileobj(data, target)
    verify(dest, checksum)


def rebuild(stage, archive, current_root):
    if archive is None:
        archive = stage / "tmt-2020.zip"
        with urlopen(PUBLIC_URL, timeout=90) as response, archive.open("wb") as target:
            shutil.copyfileobj(response, target)
    verify(archive, PUBLIC_HASH)
    verify(FEST_SOURCE, FEST_HASH)
    public_root = stage / "tmt-2020"
    legacy = prepare_public(archive, public_root)
    release = CURRENT_RELEASE if current_root is not None else PUBLIC_RELEASE
    report = build(current_root or public_root, release, legacy, FEST_SOURCE, stage)
    if current_root is not None:
        expected = json.loads((REFERENCE_DIR / "tmt-20261116-sha256.json").read_text())
        if any(report["input_sha256"][key] != checksum for key, checksum in expected.items()):
            raise ValueError("Thai workbook content differs from the audited November 2026 release")


def install(out, archive=None, current_root=None, rebuild_2020=False):
    out.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=out) as temp:
        stage = Path(temp)
        index = stage / "fest-interactions.sqlite"
        mapping = stage / "tmt-fest-mapping.sqlite"
        unpack(FEST_DIR / "fest-interactions.sqlite.gz", index, INDEX_HASH)
        if rebuild_2020 or archive is not None or current_root is not None:
            rebuild(stage, archive, current_root)
        else:
            unpack(REFERENCE_DIR / "tmt-20200217" / "tmt-fest-mapping.sqlite.gz", mapping, MAPPING_HASH)
        with closing(sqlite3.connect(mapping)) as db:
            metadata = dict(db.execute("SELECT key,value FROM metadata"))
            if metadata["fest_sha256"] != FEST_HASH:
                raise ValueError("TMT mapping and FEST index refer to different releases")
            counts = db.execute("""
                SELECT count(*), sum(composition_status='complete'), sum(ddi_status='mapped')
                FROM product WHERE active_tmt=1
            """).fetchone()
        # Both install modes share the identical FEST index. Publish the selected mapping last.
        index.replace(out / index.name)
        mapping.replace(out / mapping.name)
        return metadata["tmt_release"], counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    variants = parser.add_mutually_exclusive_group()
    variants.add_argument("--rebuild-2020", action="store_true", help="Rebuild using the public workbook download")
    parser.add_argument("--tmt-2020-zip", type=Path, help="Use a local copy of the pinned public ZIP")
    variants.add_argument("--tmt-2026-root", type=Path, help="Use the extracted authorized November 2026 catalogue")
    parser.add_argument("--out", type=Path, default=REFERENCE_DIR / "installed")
    args = parser.parse_args()
    try:
        release, (products, ingredients, mapped) = install(args.out, args.tmt_2020_zip, args.tmt_2026_root, args.rebuild_2020)
    except ModuleNotFoundError as exc:
        if exc.name != "xlrd":
            raise
        sys.exit("Rebuilding from workbooks requires xlrd==2.0.2. Use uv run --with xlrd==2.0.2 for this command.")
    except (OSError, URLError, ValueError, BadZipFile, KeyError, EOFError) as exc:
        sys.exit(f"Reference installation failed: {exc}")
    print(f"Installed {release} and {FEST_SOURCE.stem} in {args.out.resolve()}")
    print(f"{products:,} products, {ingredients:,} eligible for exact ingredient comparison, {mapped:,} mapped for DDI.")


if __name__ == "__main__":
    main()
