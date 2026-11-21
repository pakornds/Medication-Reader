"""Open operator-supplied reference files without creating or writing databases."""

import os
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path

INSTALL_DIR = Path(__file__).resolve().parents[3] / "reference-data" / "installed"
FILENAMES = {"LOCAL_TMT_DB": "tmt-fest-mapping.sqlite", "LOCAL_FEST_DB": "fest-interactions.sqlite"}

@contextmanager
def open_reference(variable: str) -> Iterator[sqlite3.Connection]:
    path = os.environ.get(variable) or INSTALL_DIR / FILENAMES[variable]
    uri = Path(path).expanduser().resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        yield connection
