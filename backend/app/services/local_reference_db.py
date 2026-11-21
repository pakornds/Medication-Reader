"""Open operator-supplied reference files without creating or writing databases."""

import os
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path


@contextmanager
def open_reference(variable: str) -> Iterator[sqlite3.Connection]:
    path = os.environ.get(variable)
    if not path:
        raise sqlite3.OperationalError(f"{variable} is not configured")
    uri = Path(path).expanduser().resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        yield connection
