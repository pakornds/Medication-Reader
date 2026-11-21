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
SUBSTANCE_GAP = "no_exact_fest_substance"
ATC = re.compile(r"[A-Z][0-9]{2}[A-Z]{2}[0-9]{2}")
POLICY_VERSION = "ingredient-route-2"
REVIEWED_TMT_RELEASES = frozenset({"TMTRF20200217", "TMTRF20261116"})


@dataclass(frozen=True)
class ReviewedMapping:
    atcs: tuple[str, ...]
    form: str
    references: tuple[tuple[str, str], ...]


# These mappings have a route and formulation source beyond the active FEST
# formulation catalogue. They belong to ingredients, so every FEST rule can use them.
REVIEWED = {
    ("689632", "ferrous fumarate"): ReviewedMapping(("B03AA02",), "53", (
        ("WHO ATC/DDD Index · oral ferrous fumarate (B03AA02)", WHO_ATC + "B03AA02"),
    )),
    ("864627", "tramadol hydrochloride"): ReviewedMapping(("N02AX02",), "53", (
        ("WHO ATC/DDD Index · oral tramadol (N02AX02)", WHO_ATC + "N02AX02"),
        ("DailyMed · tramadol hydrochloride tablets for oral use",
         "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=ccb3e0f9-57db-40bc-84d2-b66a827a5b96"),
    )),
    ("225929", "warfarin sodium"): ReviewedMapping(("B01AA03",), "53", (
        ("WHO ATC/DDD Index · oral warfarin (B01AA03)", WHO_ATC + "B01AA03"),
        ("DailyMed · warfarin sodium tablets for oral use",
         "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=bd6ea120-5d1c-4815-94f2-81e28dc6b7a9"),
    )),
    # The national product indication selects the aspirin ATC. The catalogue
    # supplies its identity and route, so keep both documented oral possibilities.
    ("223308", "aspirin"): ReviewedMapping(("B01AC06", "N02BA01"), "53", (
        ("WHO ATC/DDD Index · acetylsalicylic acid for antiplatelet use (B01AC06)", WHO_ATC + "B01AC06"),
        ("WHO ATC/DDD Index · acetylsalicylic acid for pain relief (N02BA01)", WHO_ATC + "N02BA01"),
    )),
}


@dataclass(frozen=True)
class IngredientATC:
    atcs: tuple[str, ...]
    references: list[Reference]


@dataclass(frozen=True)
class IngredientRoutes:
    version: str
    ingredients: dict
    blocked: dict

    def resolve(self, *, release: str, ingredients: dict[str, str], form_route: tuple[str, str],
                composition_status: str | None, ddi_status: str | None) -> IngredientATC | None:
        form, route = form_route
        if (composition_status != "complete" or ddi_status not in {EXACT_FORM_GAP, SUBSTANCE_GAP} or len(ingredients) != 1
                or route != ORAL or form not in ORAL_SOLID_FORMS):
            return None
        (substance_id, raw_name), = ingredients.items()
        name = " ".join(unicodedata.normalize("NFC", raw_name).casefold().split())
        blocked_routes = self.blocked.get(name, ())
        if route in blocked_routes or "*" in blocked_routes:
            return None
        source = self.ingredients.get(name, {}).get(route)
        if ddi_status == EXACT_FORM_GAP and source is not None:
            forms = source["products_by_form"]
            compatible = sorted(forms.keys() & ORAL_SOLID_FORMS)
            if not compatible:
                return None
            product_id = forms[compatible[0]]
            atc = source["atc"]
            return IngredientATC((atc,), [
                Reference(title=f"FEST · {name} ({atc}), product {product_id}", url=FEST_URL),
            ])
        reviewed = REVIEWED.get((substance_id, name))
        if reviewed and release in REVIEWED_TMT_RELEASES and form == reviewed.form:
            return IngredientATC(reviewed.atcs, [
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


# These summaries describe the whole FEST rule group, including drug-class members.
RULE_SUMMARIES = {
    "ID_45F34CDB-4002-4DA6-8846-9F8F00E6A177": (
        "Iron can reduce absorption of tetracycline antibiotics when taken together.",
        "ธาตุเหล็กอาจลดการดูดซึมยาปฏิชีวนะกลุ่มเตตราไซคลินเมื่อรับประทานพร้อมกัน",
    ),
    "ID_7CF378BE-9392-4278-B48E-A95E00B6774E": (
        "Using an opioid and gabapentin together can increase drowsiness and the risk of slowed breathing.",
        "การใช้ยาโอปิออยด์ร่วมกับกาบาเพนตินอาจทำให้ง่วงมากขึ้นและเพิ่มความเสี่ยงต่อการหายใจช้าลง",
    ),
    "ID_3278CC6E-A001-477A-B228-9F8A012763E8": (
        "Using warfarin and aspirin together can increase bleeding risk.",
        "การใช้วาร์ฟารินร่วมกับแอสไพรินอาจเพิ่มความเสี่ยงต่อการมีเลือดออก",
    ),
    "ID_CD3ACB87-D556-4458-9A2C-A1FD00FEEFAE": (
        "Using warfarin and aspirin together can increase bleeding risk.",
        "การใช้วาร์ฟารินร่วมกับแอสไพรินอาจเพิ่มความเสี่ยงต่อการมีเลือดออก",
    ),
}
