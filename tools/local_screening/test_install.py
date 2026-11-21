"""Exercise the real bundled resources and the deployment path without making network requests."""
import sqlite3
from contextlib import closing

import pytest

from install import install


def test_bundled_install_and_failed_rebuild_preserve_release(tmp_path):
    out = tmp_path / "installed"
    assert install(out) == ("TMTRF20200217", (30683, 30160, 9537))
    invalid = tmp_path / "wrong-release.zip"
    invalid.write_bytes(b"wrong release")
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        install(out, archive=invalid)
    with closing(sqlite3.connect(out / "tmt-fest-mapping.sqlite")) as db:
        assert db.execute("SELECT value FROM metadata WHERE key='tmt_release'").fetchone() == ("TMTRF20200217",)
    with closing(sqlite3.connect(out / "fest-interactions.sqlite")) as db:
        assert db.execute("SELECT COUNT(*) FROM rule").fetchone() == (11159,)
