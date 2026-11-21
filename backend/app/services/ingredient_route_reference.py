"""Resolve supported oral ingredient ATCs independently of the interaction rules."""

import gzip
import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.schemas.local_screening import Reference
from app.services.local_reference_db import INSTALL_DIR

REFERENCE_PATH = INSTALL_DIR.parent / "fest-20261111" / "ingredient-routes.json.gz"
FEST_URL = "https://www.dmp.no/en/about-us/distribution-of-data-on-medicinal-products/electronic-prescription-support-system-fest/downloading-fest-and-safest"
WHO_ATC = "https://atcddd.fhi.no/atc_ddd_index/?code="
ORAL = "53"
# FEST 7448 conventional tablet (including film-coated) and hard capsule. Keep
# modified release, gastro-resistant, other administration routes and mixtures out.
ORAL_SOLID_FORMS = frozenset({"53", "891"})
EXACT_FORM_GAP = "no_exact_fest_product_form_route"
ATC = re.compile(r"[A-Z][0-9]{2}[A-Z]{2}[0-9]{2}")
POLICY_VERSION = "ingredient-route-1"
REVIEWED_TMT_RELEASES = frozenset({"TMTRF20200217", "TMTRF20261116"})


@dataclass(frozen=True)
class ReviewedMapping:
    atc: str
    form: str
    references: tuple[tuple[str, str], ...]


# These mappings have a route and formulation source beyond the active FEST
# formulation catalogue. They belong to ingredients, so every FEST rule can use them.
REVIEWED = {
    ("689632", "ferrous fumarate"): ReviewedMapping("B03AA02", "53", (
        ("WHO ATC/DDD Index · oral ferrous fumarate (B03AA02)", WHO_ATC + "B03AA02"),
    )),
    ("864627", "tramadol hydrochloride"): ReviewedMapping("N02AX02", "53", (
        ("WHO ATC/DDD Index · oral tramadol (N02AX02)", WHO_ATC + "N02AX02"),
        ("DailyMed · tramadol hydrochloride tablets for oral use",
         "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=ccb3e0f9-57db-40bc-84d2-b66a827a5b96"),
    )),
}


@dataclass(frozen=True)
class IngredientATC:
    atc: str
    references: list[Reference]


@dataclass(frozen=True)
class IngredientRoutes:
    version: str
    ingredients: dict
    blocked: dict

    def resolve(self, *, release: str, ingredients: dict[str, str], form_route: tuple[str, str],
                composition_status: str | None, ddi_status: str | None) -> IngredientATC | None:
        form, route = form_route
        if (composition_status != "complete" or ddi_status != EXACT_FORM_GAP or len(ingredients) != 1
                or route != ORAL or form not in ORAL_SOLID_FORMS):
            return None
        (substance_id, raw_name), = ingredients.items()
        name = " ".join(unicodedata.normalize("NFC", raw_name).casefold().split())
        blocked_routes = self.blocked.get(name, ())
        if route in blocked_routes or "*" in blocked_routes:
            return None
        source = self.ingredients.get(name, {}).get(route)
        if source is not None:
            forms = source["products_by_form"]
            compatible = sorted(forms.keys() & ORAL_SOLID_FORMS)
            if not compatible:
                return None
            product_id = forms[compatible[0]]
            atc = source["atc"]
            return IngredientATC(atc, [
                Reference(title=f"FEST · {name} ({atc}), product {product_id}", url=FEST_URL),
            ])
        reviewed = REVIEWED.get((substance_id, name))
        if reviewed and release in REVIEWED_TMT_RELEASES and form == reviewed.form:
            return IngredientATC(reviewed.atc, [
                Reference(title=title, url=url) for title, url in reviewed.references
            ])
        return None


@lru_cache(maxsize=4)
def load_routes(fest_sha: str, path: Path = REFERENCE_PATH) -> IngredientRoutes | None:
    try:
        raw = gzip.decompress(path.read_bytes())
        payload = json.loads(raw)
        if payload["format_version"] != 1 or payload["fest_sha256"] != fest_sha:
            return None
        ingredients, blocked = payload["ingredients"], payload["blocked"]
        for routes in ingredients.values():
            for value in routes.values():
                forms = value["products_by_form"]
                if not ATC.fullmatch(value["atc"]) or not isinstance(forms, dict) or not forms:
                    return None
                if not all(isinstance(product, str) and product for product in forms.values()):
                    return None
        if any(not isinstance(routes, list) or not all(isinstance(route, str) for route in routes)
               for routes in blocked.values()):
            return None
    except (OSError, EOFError, KeyError, TypeError, ValueError, AttributeError):
        return None
    version = f"{POLICY_VERSION}-{hashlib.sha256(raw).hexdigest()[:12]}"
    return IngredientRoutes(version, ingredients, blocked)


# Short translations of these FEST findings used in the existing demo.
RULE_SUMMARIES = {
    "ID_45F34CDB-4002-4DA6-8846-9F8F00E6A177": (
        "Iron can reduce doxycycline absorption when taken together.",
        "ธาตุเหล็กอาจลดการดูดซึมด็อกซีไซคลินเมื่อรับประทานพร้อมกัน",
    ),
    "ID_7CF378BE-9392-4278-B48E-A95E00B6774E": (
        "Using tramadol and gabapentin together can increase drowsiness and the risk of slowed breathing.",
        "การใช้ทรามาดอลร่วมกับกาบาเพนตินอาจทำให้ง่วงมากขึ้นและเพิ่มความเสี่ยงต่อการหายใจช้าลง",
    ),
}
