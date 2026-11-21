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
        db.execute("CREATE TABLE product(tpu TEXT, label TEXT, ddi_status TEXT, active_tmt INTEGER)")
        db.executemany("INSERT INTO product VALUES (?,?,?,?)", [
            ("901", "Test Alpha 10 mg tablet", "mapped", 1),
            ("902", "Test Beta 1% cream", "unmapped", 1),
        ])
    monkeypatch.setenv("LOCAL_TMT_DB", str(path))
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        async def matches(q):
            response = await client.get("/checks/local/products", params={"q": q})
            assert response.status_code == 200
            assert response.json()["tmt_release"] == "test-release"
            return [row["tpu"] for row in response.json()["products"]]

        assert await matches("902") == ["902"]
        assert await matches("tablet alpha") == ["901"]
        assert await matches("%") == ["902"]
        assert await matches("   ") == []
        assert await matches("unknown") == []
        missing = tmp_path / "missing.sqlite"
        monkeypatch.setenv("LOCAL_TMT_DB", str(missing))
        assert (await client.get("/checks/local/products", params={"q": "902"})).status_code == 503
        assert not missing.exists()
