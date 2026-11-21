import sqlite3

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app


@pytest.mark.anyio
async def test_local_catalogue_search_includes_unmapped_products(tmp_path, monkeypatch):
    path = tmp_path / "catalogue #1.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT)")
        db.execute("INSERT INTO metadata VALUES ('tmt_release','test-release')")
        db.execute("""CREATE TABLE product(
            tpu TEXT, label TEXT, ddi_status TEXT, active_tmt INTEGER,
            source_generic TEXT, source_strength TEXT, form TEXT
        )""")
        db.executemany("INSERT INTO product VALUES (?,?,?,?,?,?,?)", [
            ("901", "Test Alpha 10 mg tablet", "mapped", 1, "Alpha", "10 mg", "tablet"),
            ("902", "Test Beta 1% cream", "unmapped", 1, "", "", ""),
            ("903", "Test Gamma combination", "unmapped", 0, "Gamma and combinations", "", "tablet"),
        ])
    monkeypatch.setenv("LOCAL_TMT_DB", str(path))
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        async def matches(q):
            response = await client.get("/checks/local/products", params={"q": q})
            assert response.status_code == 200
            assert response.json()["tmt_release"] == "test-release"
            return response.json()["products"]

        assert await matches("tablet alpha") == await matches("901") == [{
            "tpu": "901", "label": "Test Alpha 10 mg tablet", "active_tmt": True,
            "source_generic": "Alpha", "strength": "10 mg", "dose_form": "tablet",
        }]
        assert await matches("%") == await matches("902") == [{
            "tpu": "902", "label": "Test Beta 1% cream", "active_tmt": True,
            "source_generic": "", "strength": "", "dose_form": "",
        }]
        assert await matches("combination") == [{
            "tpu": "903", "label": "Test Gamma combination", "active_tmt": False,
            "source_generic": "Gamma and combinations", "strength": "", "dose_form": "tablet",
        }]
        assert await matches("   ") == []
        assert await matches("unknown") == []
        missing = tmp_path / "missing.sqlite"
        monkeypatch.setenv("LOCAL_TMT_DB", str(missing))
        assert (await client.get("/checks/local/products", params={"q": "902"})).status_code == 503
        assert not missing.exists()
