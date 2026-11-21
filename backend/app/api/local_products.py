"""Search the same local TMT product table used by screening, including unmapped rows."""

import sqlite3
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from app.schemas.evidence import ContractModel
from app.services.local_reference_db import open_reference

router = APIRouter(tags=["local screening"])


class ProductOption(ContractModel):
    tpu: str
    label: str
    active_tmt: bool


class ProductOptions(ContractModel):
    tmt_release: str
    products: list[ProductOption]


@router.get("/checks/local/products", response_model=ProductOptions)
def local_products(q: Annotated[str, Query(min_length=1, max_length=120)]) -> ProductOptions:
    terms = q.strip().lower().split()
    # All tokens are parameters. Literal %, underscores and apostrophes are searchable.
    matches = " AND ".join("instr(lower(label), ?) > 0" for _ in terms)
    statement = f"""
        SELECT tpu, label, active_tmt FROM product
        WHERE tpu = ? OR ({matches})
        ORDER BY (tpu = ?) DESC, active_tmt DESC, length(label), label, tpu LIMIT 30
    """
    try:
        with open_reference("LOCAL_TMT_DB") as db:
            meta = db.execute("SELECT value FROM metadata WHERE key='tmt_release'").fetchone()
            if not meta or not meta[0]:
                raise sqlite3.OperationalError("Missing TMT release")
            rows = db.execute(statement, (q.strip(), *terms, q.strip())).fetchall() if terms else []
    except sqlite3.Error:
        raise HTTPException(503, "Local Thai product catalogue is unavailable.") from None
    return ProductOptions(tmt_release=meta[0], products=[ProductOption(**row) for row in rows])
